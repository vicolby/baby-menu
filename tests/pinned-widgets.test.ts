import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PINNED_WIDGET_SIZE,
  MIN_PINNED_WIDGET_SIZE,
  PINNED_WIDGET_RELATIVE_LEVEL,
  clampToWorkArea,
  createPinnedWidgetOptions,
  createPinnedWidgetStore,
  createPinnedWidgetWindows,
  nextPinnedPosition,
  type PinnedWindow,
} from "../src/main/pinned-widgets";

const WORK_AREA: Rectangle = { x: 0, y: 25, width: 1440, height: 875 };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baby-menu-pinned-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createPinnedWidgetOptions", () => {
  it("keeps the popover security flags and never forces always-on-top", () => {
    const options = createPinnedWidgetOptions("/app/preload.js", { x: 10, y: 20, ...DEFAULT_PINNED_WIDGET_SIZE });

    expect(options).toMatchObject({ x: 10, y: 20, frame: false, show: false, skipTaskbar: true, resizable: false });
    expect(options.webPreferences).toMatchObject({
      preload: "/app/preload.js",
      contextIsolation: true,
      nodeIntegration: false,
    });
    // The level is applied after creation (negative relative level); a plain
    // alwaysOnTop flag would put the widget above every app instead.
    expect(options.alwaysOnTop).toBeUndefined();
  });

  it("lets the first click through to the widget on an inactive app", () => {
    expect(createPinnedWidgetOptions("/p.js", { ...DEFAULT_PINNED_WIDGET_SIZE }).acceptFirstMouse).toBe(true);
  });
});

describe("window placement", () => {
  it("starts the first widget at the top-right corner of the work area", () => {
    expect(nextPinnedPosition(WORK_AREA, [], { width: 360, height: 160 })).toEqual({ x: 1440 - 360 - 16, y: 25 + 16 });
  });

  it("stacks new widgets under the lowest existing one", () => {
    const existing: Rectangle[] = [{ x: 1064, y: 41, width: 360, height: 160 }];

    expect(nextPinnedPosition(WORK_AREA, existing, { width: 360, height: 160 })).toEqual({ x: 1064, y: 41 + 160 + 12 });
  });

  it("cascades instead of leaving the screen when the column is full", () => {
    const existing: Rectangle[] = [{ x: 1064, y: 41, width: 360, height: 820 }];

    const position = nextPinnedPosition(WORK_AREA, existing, { width: 360, height: 160 });

    expect(position.y + 160).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
    expect(position.y).toBeGreaterThanOrEqual(WORK_AREA.y);
  });

  it("pulls a window saved on a disconnected display back into the work area", () => {
    expect(clampToWorkArea({ x: 5000, y: -300, width: 360, height: 160 }, WORK_AREA)).toEqual({
      x: 1440 - 360,
      y: 25,
      width: 360,
      height: 160,
    });
  });

  it("shrinks a window larger than the work area", () => {
    const clamped = clampToWorkArea({ x: 0, y: 0, width: 3000, height: 3000 }, WORK_AREA);

    expect(clamped.width).toBe(WORK_AREA.width);
    expect(clamped.height).toBe(WORK_AREA.height);
  });
});

describe("createPinnedWidgetStore", () => {
  it("is empty when nothing was saved yet", async () => {
    const store = createPinnedWidgetStore(join(dir, "pinned.json"));

    await expect(store.load()).resolves.toEqual([]);
  });

  it("recovers from a corrupt file instead of failing startup", async () => {
    const file = join(dir, "pinned.json");
    await writeFile(file, "{not json");

    await expect(createPinnedWidgetStore(file).load()).resolves.toEqual([]);
  });

  it("drops malformed and duplicate entries but keeps valid ones", async () => {
    const file = join(dir, "pinned.json");
    await writeFile(
      file,
      JSON.stringify({
        widgets: [
          { id: "clock", x: 10, y: 20 },
          { id: "clock", x: 99, y: 99 },
          { id: "" },
          { id: 42 },
          null,
          { id: "weather", x: "left", y: Number.NaN },
        ],
      }),
    );

    await expect(createPinnedWidgetStore(file).load()).resolves.toEqual([{ id: "clock", x: 10, y: 20 }, { id: "weather" }]);
  });

  it("persists pins, positions and unpins across instances", async () => {
    const file = join(dir, "pinned.json");
    const store = createPinnedWidgetStore(file);
    await store.load();

    await store.pin("clock");
    await store.pin("clock");
    await store.pin("weather");
    await store.setPosition("clock", { x: 11.6, y: 22.2 });
    await store.unpin("weather");

    await expect(createPinnedWidgetStore(file).load()).resolves.toEqual([{ id: "clock", x: 12, y: 22 }]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ widgets: [{ id: "clock", x: 12, y: 22 }] });
  });

  it("ignores positions for widgets that are not pinned", async () => {
    const store = createPinnedWidgetStore(join(dir, "pinned.json"));
    await store.load();

    await store.setPosition("ghost", { x: 1, y: 2 });

    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes concurrent writes without losing a pin", async () => {
    const file = join(dir, "pinned.json");
    const store = createPinnedWidgetStore(file);
    await store.load();

    await Promise.all(["a", "b", "c", "d"].map((id) => store.pin(id)));

    const saved = await createPinnedWidgetStore(file).load();
    expect(saved.map((entry) => entry.id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

type FakeWindow = PinnedWindow & {
  emit: (event: "moved" | "closed") => void;
  bounds: Rectangle;
  crashed: boolean;
};

function createFakeWindowFactory() {
  const windows: FakeWindow[] = [];
  const createWindow = vi.fn((_widgetId: string, bounds: Rectangle) => {
    const listeners = new Map<string, () => void>();
    const calls: string[] = [];
    let destroyed = false;
    const window: FakeWindow = {
      bounds,
      crashed: false,
      webContents: {
        id: 100 + windows.length,
        isCrashed: () => window.crashed,
        send: vi.fn(),
      },
      isDestroyed: vi.fn(() => destroyed),
      getBounds: vi.fn(() => window.bounds),
      setBounds: vi.fn((next: Rectangle) => {
        window.bounds = next;
      }),
      setAlwaysOnTop: vi.fn(() => void calls.push("level")),
      setVisibleOnAllWorkspaces: vi.fn(() => void calls.push("workspaces")),
      showInactive: vi.fn(() => void calls.push("show")),
      close: vi.fn(() => {
        destroyed = true;
        window.emit("closed");
      }),
      destroy: vi.fn(() => {
        destroyed = true;
        window.emit("closed");
      }),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return window;
      }),
      emit: (event) => listeners.get(event)?.(),
    };
    (window as FakeWindow & { calls: string[] }).calls = calls;
    windows.push(window);
    return window;
  });
  const loadWindow = vi.fn(async (_window: FakeWindow, _widgetId: string) => undefined);
  return { windows, createWindow, loadWindow };
}

// Holds every window load until `release` is called, like a slow renderer.
function gateLoads(loadWindow: ReturnType<typeof createFakeWindowFactory>["loadWindow"]) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  loadWindow.mockImplementation(async () => {
    await gate;
  });
  return () => release();
}

async function setup(initial: Array<{ id: string; x?: number; y?: number }> = []) {
  const store = createPinnedWidgetStore(join(dir, "pinned.json"));
  if (initial.length > 0) await writeFile(join(dir, "pinned.json"), JSON.stringify({ widgets: initial }));
  await store.load();
  const factory = createFakeWindowFactory();
  const controller = createPinnedWidgetWindows({
    store,
    createWindow: factory.createWindow,
    loadWindow: factory.loadWindow,
    getWorkArea: () => WORK_AREA,
  });
  return { store, controller, ...factory };
}

describe("createPinnedWidgetWindows", () => {
  it("pins a widget into a window below normal windows, on every desktop, shown without stealing focus", async () => {
    const { controller, windows, createWindow } = await setup();

    await controller.pin("clock");

    expect(createWindow).toHaveBeenCalledWith("clock", {
      x: 1440 - DEFAULT_PINNED_WIDGET_SIZE.width - 16,
      y: 25 + 16,
      ...DEFAULT_PINNED_WIDGET_SIZE,
    });
    const [window] = windows;
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, "normal", PINNED_WIDGET_RELATIVE_LEVEL);
    expect(PINNED_WIDGET_RELATIVE_LEVEL).toBeLessThan(0);
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true);
    expect(window.showInactive).toHaveBeenCalledOnce();
    // The level and workspace behaviour must be in place before the window appears.
    expect((window as FakeWindow & { calls: string[] }).calls).toEqual(["level", "workspaces", "show"]);
    expect(controller.list()).toEqual(["clock"]);
  });

  it("opens one window per widget even if pinned twice at once", async () => {
    const { controller, createWindow } = await setup();

    await Promise.all([controller.pin("clock"), controller.pin("clock")]);
    await controller.pin("clock");

    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("stacks the second pinned widget under the first", async () => {
    const { controller, createWindow } = await setup();

    await controller.pin("clock");
    await controller.pin("weather");

    expect(createWindow.mock.calls[1]?.[1]).toMatchObject({
      x: 1440 - DEFAULT_PINNED_WIDGET_SIZE.width - 16,
      y: 25 + 16 + DEFAULT_PINNED_WIDGET_SIZE.height + 12,
    });
  });

  it("does not leave a stuck pin behind when the window cannot be loaded", async () => {
    const { controller, store, windows, loadWindow } = await setup();
    loadWindow.mockRejectedValueOnce(new Error("renderer failed to load"));

    await expect(controller.pin("clock")).rejects.toThrow("renderer failed to load");

    expect(windows[0]!.destroy).toHaveBeenCalledOnce();
    expect(controller.owns(windows[0]!.webContents.id)).toBe(false);
    await expect(store.list()).resolves.toEqual([]);
    expect(controller.list()).toEqual([]);
    await controller.pin("clock");
    expect(controller.list()).toEqual(["clock"]);
  });

  // The renderer starts sending IPC (content size, visibility) while it loads, so
  // its window must already be recognised; otherwise main mistakes it for the popover.
  it("claims a window's renderer from the moment it is created, before it has loaded", async () => {
    const { controller, windows, loadWindow } = await setup();
    const release = gateLoads(loadWindow);

    const pinning = controller.pin("clock");
    await vi.waitFor(() => expect(loadWindow).toHaveBeenCalled());
    const [window] = windows;

    expect(controller.owns(window!.webContents.id)).toBe(true);
    controller.resize(window!.webContents.id, { width: 360, height: 90 });
    expect(window!.bounds).toMatchObject({ width: 360, height: 90 });
    expect(window!.showInactive).not.toHaveBeenCalled();

    release();
    await pinning;
    expect(window!.showInactive).toHaveBeenCalledOnce();
  });

  it("keeps recognising a window that is still closing after an unpin", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");
    const [closing] = windows;
    // A real window closes asynchronously; its renderer can still send IPC meanwhile.
    vi.mocked(closing!.close).mockImplementation(() => undefined);

    await controller.unpin("clock");
    await controller.pin("clock");
    const [, reopened] = windows;

    expect(controller.owns(closing!.webContents.id)).toBe(true);
    controller.resize(closing!.webContents.id, { width: 360, height: 300 });
    expect(reopened!.setBounds).not.toHaveBeenCalled();

    closing!.emit("closed");
    expect(controller.owns(closing!.webContents.id)).toBe(false);
    expect(controller.owns(reopened!.webContents.id)).toBe(true);
    expect(controller.list()).toEqual(["clock"]);
  });

  it("ends pinned with a window when pin, unpin and pin race on a slow window", async () => {
    const { controller, store, windows, loadWindow } = await setup();
    const release = gateLoads(loadWindow);

    const first = controller.pin("clock");
    await vi.waitFor(() => expect(loadWindow).toHaveBeenCalled());
    const unpinning = controller.unpin("clock");
    const second = controller.pin("clock");
    release();
    await Promise.all([first, unpinning, second]);

    await expect(store.list()).resolves.toEqual([{ id: "clock" }]);
    expect(controller.list()).toEqual(["clock"]);
    const open = windows.filter((window) => !window.isDestroyed());
    expect(open).toHaveLength(1);
    expect(open[0]!.showInactive).toHaveBeenCalledOnce();
  });

  it("ends unpinned without a window when unpin, pin and unpin race on a slow window", async () => {
    const { controller, store, windows, loadWindow } = await setup();
    await controller.pin("clock");
    loadWindow.mockClear();
    const release = gateLoads(loadWindow);

    const first = controller.unpin("clock");
    const pinning = controller.pin("clock");
    await vi.waitFor(() => expect(loadWindow).toHaveBeenCalledTimes(1));
    const second = controller.unpin("clock");
    release();
    await Promise.all([first, pinning, second]);

    await expect(store.list()).resolves.toEqual([]);
    expect(controller.list()).toEqual([]);
    expect(windows.every((window) => window.isDestroyed())).toBe(true);
  });

  it("closes the window and forgets the pin on unpin", async () => {
    const { controller, store, windows } = await setup();
    await controller.pin("clock");

    await controller.unpin("clock");

    expect(windows[0]?.close).toHaveBeenCalledOnce();
    await expect(store.list()).resolves.toEqual([]);
    expect(controller.list()).toEqual([]);
    expect(controller.owns(windows[0]!.webContents.id)).toBe(false);
  });

  it("closes a window that was still being created when the user unpinned it", async () => {
    const { controller, store, windows, loadWindow } = await setup();
    const release = gateLoads(loadWindow);

    const pinning = controller.pin("clock");
    await vi.waitFor(() => expect(loadWindow).toHaveBeenCalled());
    const unpinning = controller.unpin("clock");
    // The window finishes loading only after the unpin has already been persisted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([pinning, unpinning]);

    expect(windows[0]?.close).toHaveBeenCalledOnce();
    await expect(store.list()).resolves.toEqual([]);
    expect(controller.list()).toEqual([]);
    expect(controller.owns(windows[0]!.webContents.id)).toBe(false);
  });

  it("unpinning something that is not pinned is a no-op", async () => {
    const { controller } = await setup();

    await expect(controller.unpin("ghost")).resolves.toBeUndefined();
  });

  it("restores saved widgets at their saved positions", async () => {
    const { controller, createWindow } = await setup([
      { id: "clock", x: 100, y: 120 },
      { id: "weather", x: 500, y: 300 },
    ]);

    await controller.restore();

    expect(createWindow).toHaveBeenCalledWith("clock", { x: 100, y: 120, ...DEFAULT_PINNED_WIDGET_SIZE });
    expect(createWindow).toHaveBeenCalledWith("weather", { x: 500, y: 300, ...DEFAULT_PINNED_WIDGET_SIZE });
    expect(controller.list().sort()).toEqual(["clock", "weather"]);
  });

  it("restores a widget saved off-screen back inside the work area", async () => {
    const { controller, createWindow } = await setup([{ id: "clock", x: 9000, y: 9000 }]);

    await controller.restore();

    const bounds = createWindow.mock.calls[0]?.[1] as Rectangle;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
  });

  it("keeps restoring the rest when one widget fails to open", async () => {
    const { controller, loadWindow } = await setup([{ id: "broken" }, { id: "clock" }]);
    loadWindow.mockRejectedValueOnce(new Error("boom"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await controller.restore();

    expect(controller.list()).toEqual(["clock"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps a widget pinned after a failed restore so the next launch retries it", async () => {
    const { controller, loadWindow, store } = await setup([{ id: "broken" }]);
    loadWindow.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await controller.restore();

    await expect(store.list()).resolves.toEqual([{ id: "broken" }]);
  });

  it("saves the new position after the user drags a widget", async () => {
    const { controller, store, windows } = await setup();
    await controller.pin("clock");

    windows[0]!.bounds = { ...windows[0]!.bounds, x: 300, y: 400 };
    windows[0]!.emit("moved");

    await vi.waitFor(async () => {
      await expect(store.list()).resolves.toEqual([{ id: "clock", x: 300, y: 400 }]);
    });
  });

  it("resizes only the window that asked, keeping its position", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");
    await controller.pin("weather");
    const [clock, weather] = windows;
    const before = { x: weather!.bounds.x, y: weather!.bounds.y };

    controller.resize(clock!.webContents.id, { width: 400.2, height: 240.4 });

    expect(clock!.bounds).toMatchObject({ width: 401, height: 241 });
    expect(weather!.setBounds).not.toHaveBeenCalled();
    expect({ x: weather!.bounds.x, y: weather!.bounds.y }).toEqual(before);
  });

  it("clamps requested sizes to a usable range", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");
    const id = windows[0]!.webContents.id;

    controller.resize(id, { width: 1, height: 1 });
    expect(windows[0]!.bounds).toMatchObject(MIN_PINNED_WIDGET_SIZE);

    controller.resize(id, { width: 99999, height: 99999 });
    expect(windows[0]!.bounds.width).toBeLessThanOrEqual(WORK_AREA.width);
    expect(windows[0]!.bounds.height).toBeLessThanOrEqual(WORK_AREA.height);
    expect(windows[0]!.bounds.x).toBeGreaterThanOrEqual(WORK_AREA.x);
    expect(windows[0]!.bounds.y).toBeGreaterThanOrEqual(WORK_AREA.y);
  });

  it("ignores resize requests from windows it does not own", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");

    controller.resize(999_999, { width: 500, height: 500 });

    expect(windows[0]!.setBounds).not.toHaveBeenCalled();
  });

  it("recognises its own windows by web contents id", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");

    expect(controller.owns(windows[0]!.webContents.id)).toBe(true);
    expect(controller.owns(undefined)).toBe(false);
    expect(controller.owns(123_456)).toBe(false);
  });

  it("broadcasts only to live, healthy windows", async () => {
    const { controller, windows } = await setup();
    await controller.pin("clock");
    await controller.pin("weather");
    await controller.pin("notes");
    windows[1]!.crashed = true;
    vi.mocked(windows[2]!.isDestroyed).mockReturnValue(true);

    controller.broadcast("baby-menu:background:update", { extensionId: "clock" });

    expect(windows[0]!.webContents.send).toHaveBeenCalledWith("baby-menu:background:update", { extensionId: "clock" });
    expect(windows[1]!.webContents.send).not.toHaveBeenCalled();
    expect(windows[2]!.webContents.send).not.toHaveBeenCalled();
  });

  it("allows pinning again after its window was closed behind its back", async () => {
    const { controller, createWindow, windows } = await setup();
    await controller.pin("clock");

    windows[0]!.emit("closed");
    await controller.pin("clock");

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(controller.list()).toEqual(["clock"]);
  });
});
