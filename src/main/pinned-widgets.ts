import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import { PINNED_WIDGET_WIDTH } from "../shared/pinned-widget";
import type { Size } from "./popover";

export const DEFAULT_PINNED_WIDGET_SIZE: Size = { width: PINNED_WIDGET_WIDTH, height: 160 };
export const MIN_PINNED_WIDGET_SIZE: Size = { width: 120, height: 48 };

// Pinned widgets sit between the desktop icons and every normal window. Measured
// on macOS 26 with Electron 42: `type: "desktop"` lands one level below the Finder
// icon layer and never receives a mouse event, while a negative relative level on
// top of "normal" stays interactive and still sits under all app windows. Do not
// raise this to 0 or above, which would float the widget over the user's work.
export const PINNED_WIDGET_RELATIVE_LEVEL = -1000;

const EDGE_PADDING = 16;
const STACK_GAP = 12;
const CASCADE_STEP = 24;

export function createPinnedWidgetOptions(
  preloadPath: string,
  bounds: Partial<Pick<Rectangle, "x" | "y">> & Size,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    frame: false,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // The widget draws its own rounded card, so the window itself is invisible.
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    // The app is an accessory app and rarely active: without this, the first click
    // on a pinned widget would only activate the app and never reach the widget.
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function clampToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

export function nextPinnedPosition(workArea: Rectangle, existing: Rectangle[], size: Size): { x: number; y: number } {
  const x = workArea.x + workArea.width - size.width - EDGE_PADDING;
  const y =
    existing.length === 0
      ? workArea.y + EDGE_PADDING
      : Math.max(...existing.map((bounds) => bounds.y + bounds.height)) + STACK_GAP;
  if (y + size.height <= workArea.y + workArea.height - EDGE_PADDING) return { x, y };

  // The column is full: cascade from the top so the new widget stays reachable.
  const offset = (existing.length * CASCADE_STEP) % (workArea.height / 2);
  const placed = clampToWorkArea(
    { x: x - offset, y: workArea.y + EDGE_PADDING + offset, ...size },
    workArea,
  );
  return { x: placed.x, y: placed.y };
}

export type PinnedWidgetRecord = {
  id: string;
  x?: number;
  y?: number;
};

export type PinnedWidgetStore = {
  load: () => Promise<PinnedWidgetRecord[]>;
  list: () => Promise<PinnedWidgetRecord[]>;
  pin: (id: string) => Promise<void>;
  unpin: (id: string) => Promise<void>;
  setPosition: (id: string, position: { x: number; y: number }) => Promise<void>;
};

const MAX_WIDGET_ID_LENGTH = 256;

function sanitizeRecords(value: unknown): PinnedWidgetRecord[] {
  const entries = (value as { widgets?: unknown } | null)?.widgets;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const records: PinnedWidgetRecord[] = [];
  for (const entry of entries) {
    const { id, x, y } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_WIDGET_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      records.push({ id, x: Math.round(x), y: Math.round(y) });
    } else {
      records.push({ id });
    }
  }
  return records;
}

// Persists which widgets are pinned and where, so they come back after a restart.
// A missing or corrupt file means "nothing pinned": a bad file must never block startup.
export function createPinnedWidgetStore(filePath: string): PinnedWidgetStore {
  let records: PinnedWidgetRecord[] | null = null;
  let writes: Promise<void> = Promise.resolve();

  async function load(): Promise<PinnedWidgetRecord[]> {
    try {
      records = sanitizeRecords(JSON.parse(await readFile(filePath, "utf8")));
    } catch {
      records = [];
    }
    return records.map((record) => ({ ...record }));
  }

  async function list(): Promise<PinnedWidgetRecord[]> {
    if (records === null) return load();
    return records.map((record) => ({ ...record }));
  }

  // Mutations apply to memory synchronously and persist through a queue, so
  // concurrent callers cannot interleave writes and lose each other's change.
  function mutate(change: (current: PinnedWidgetRecord[]) => PinnedWidgetRecord[]): Promise<void> {
    const run = async () => {
      if (records === null) await load();
      records = change(records ?? []);
      const snapshot = JSON.stringify({ widgets: records }, null, 2);
      await mkdir(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      await writeFile(temp, snapshot);
      await rename(temp, filePath);
    };
    const result = writes.then(run);
    writes = result.catch(() => undefined);
    return result;
  }

  return {
    load,
    list,
    pin: (id) => mutate((current) => (current.some((record) => record.id === id) ? current : [...current, { id }])),
    unpin: (id) => mutate((current) => current.filter((record) => record.id !== id)),
    setPosition: (id, position) =>
      mutate((current) =>
        current.map((record) =>
          record.id === id ? { id, x: Math.round(position.x), y: Math.round(position.y) } : record,
        ),
      ),
  };
}

// The slice of BrowserWindow the controller drives; a structural subset so tests
// can supply a fake and the real window stays assignable.
export type PinnedWindow = {
  webContents: {
    id: number;
    isCrashed: () => boolean;
    send: (channel: string, ...args: unknown[]) => void;
  };
  isDestroyed: () => boolean;
  getBounds: () => Rectangle;
  setBounds: (bounds: Rectangle) => void;
  setAlwaysOnTop: (flag: boolean, level: "normal", relativeLevel: number) => void;
  setVisibleOnAllWorkspaces: (visible: boolean) => void;
  showInactive: () => void;
  close: () => void;
  on(event: "moved", listener: () => void): unknown;
  on(event: "closed", listener: () => void): unknown;
};

export type PinnedWidgetWindowsOptions = {
  store: PinnedWidgetStore;
  // Creates the window and resolves once its renderer has loaded, still hidden.
  createWindow: (widgetId: string, bounds: Rectangle) => Promise<PinnedWindow>;
  getWorkArea: (point?: { x: number; y: number }) => Rectangle;
};

export type PinnedWidgetWindows = {
  restore: () => Promise<void>;
  pin: (id: string) => Promise<void>;
  unpin: (id: string) => Promise<void>;
  list: () => string[];
  owns: (webContentsId: number | undefined) => boolean;
  resize: (webContentsId: number | undefined, size: Size) => void;
  broadcast: (channel: string, payload: unknown) => void;
};

export function createPinnedWidgetWindows({
  store,
  createWindow,
  getWorkArea,
}: PinnedWidgetWindowsOptions): PinnedWidgetWindows {
  const windows = new Map<string, PinnedWindow>();
  const widgetByContentsId = new Map<number, string>();
  const opening = new Map<string, Promise<void>>();

  function liveWindow(id: string): PinnedWindow | undefined {
    const window = windows.get(id);
    return window && !window.isDestroyed() ? window : undefined;
  }

  function liveBounds(): Rectangle[] {
    return [...windows.values()].filter((window) => !window.isDestroyed()).map((window) => window.getBounds());
  }

  function open(id: string, bounds: Rectangle): Promise<void> {
    if (liveWindow(id)) return Promise.resolve();
    const pending = opening.get(id);
    if (pending) return pending;

    const task = (async () => {
      const window = await createWindow(id, bounds);
      // Everything that shapes how the widget sits on the desktop is in place
      // before it appears, so it never flashes over normal windows.
      window.setAlwaysOnTop(true, "normal", PINNED_WIDGET_RELATIVE_LEVEL);
      window.setVisibleOnAllWorkspaces(true);
      // webContents is gone once the window is destroyed, so capture the id now.
      const contentsId = window.webContents.id;
      windows.set(id, window);
      widgetByContentsId.set(contentsId, id);
      window.on("moved", () => {
        const { x, y } = window.getBounds();
        void store.setPosition(id, { x, y }).catch((error) => {
          console.error("[baby-menu] failed to save pinned widget position", error);
        });
      });
      window.on("closed", () => {
        if (windows.get(id) === window) windows.delete(id);
        widgetByContentsId.delete(contentsId);
      });
      window.showInactive();
    })().finally(() => opening.delete(id));
    opening.set(id, task);
    return task;
  }

  function newWidgetBounds(): Rectangle {
    const size = DEFAULT_PINNED_WIDGET_SIZE;
    return { ...nextPinnedPosition(getWorkArea(), liveBounds(), size), ...size };
  }

  return {
    async restore() {
      // Sequential on purpose: widgets without a saved position are stacked
      // relative to the ones already placed.
      for (const record of await store.list()) {
        try {
          const bounds =
            record.x !== undefined && record.y !== undefined
              ? clampToWorkArea(
                  { x: record.x, y: record.y, ...DEFAULT_PINNED_WIDGET_SIZE },
                  getWorkArea({ x: record.x, y: record.y }),
                )
              : newWidgetBounds();
          await open(record.id, bounds);
        } catch (error) {
          // Stays pinned in the store, so the next launch retries it.
          console.error(`[baby-menu] failed to restore pinned widget "${record.id}"`, error);
        }
      }
    },

    async pin(id) {
      if (liveWindow(id)) return;
      await store.pin(id);
      try {
        await open(id, newWidgetBounds());
      } catch (error) {
        await store.unpin(id);
        throw error;
      }
    },

    async unpin(id) {
      await store.unpin(id);
      // A window still being created registers itself once loaded; wait for it so
      // it is closed here instead of appearing after the user already unpinned.
      await opening.get(id)?.catch(() => undefined);
      const window = windows.get(id);
      windows.delete(id);
      for (const [contentsId, widgetId] of widgetByContentsId) {
        if (widgetId === id) widgetByContentsId.delete(contentsId);
      }
      if (window && !window.isDestroyed()) window.close();
    },

    list: () => [...windows.keys()].filter((id) => liveWindow(id)),

    owns: (webContentsId) => webContentsId !== undefined && widgetByContentsId.has(webContentsId),

    resize(webContentsId, size) {
      const id = webContentsId === undefined ? undefined : widgetByContentsId.get(webContentsId);
      const window = id === undefined ? undefined : liveWindow(id);
      if (!window) return;

      const current = window.getBounds();
      const workArea = getWorkArea({ x: current.x, y: current.y });
      const width = clamp(Math.ceil(size.width), MIN_PINNED_WIDGET_SIZE.width, workArea.width);
      const height = clamp(Math.ceil(size.height), MIN_PINNED_WIDGET_SIZE.height, workArea.height);
      if (width === current.width && height === current.height) return;
      window.setBounds(clampToWorkArea({ ...current, width, height }, workArea));
    },

    broadcast(channel, payload) {
      for (const window of windows.values()) {
        if (window.isDestroyed() || window.webContents.isCrashed()) continue;
        window.webContents.send(channel, payload);
      }
    },
  };
}
