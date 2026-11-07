/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { PinModeProvider, PinModeToggle } from "../src/renderer/menu/pin-mode";
import { WidgetHost } from "../src/renderer/menu/WidgetHost";
import type { BabyMenuLayout, RefreshableBabyMenuWidget } from "../src/shared/contracts";

type VisibilityListener = (state: { visible: boolean }) => void;

function installBridge(pinnedIds: string[] = []) {
  const visibilityListeners = new Set<VisibilityListener>();
  const pinned = {
    list: vi.fn(async () => [...pinnedIds]),
    pin: vi.fn(async (id: string) => {
      if (!pinnedIds.includes(id)) pinnedIds.push(id);
      return [...pinnedIds];
    }),
    unpin: vi.fn(async (id: string) => {
      if (pinnedIds.includes(id)) pinnedIds.splice(pinnedIds.indexOf(id), 1);
      return [...pinnedIds];
    }),
  };
  const popover = {
    getVisibility: vi.fn(async () => ({ visible: true })),
    onVisibility: vi.fn((listener: VisibilityListener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    }),
  };
  const widgets = { list: vi.fn(async () => []) };
  window.babyMenu = { pinned, popover, widgets } as unknown as typeof window.babyMenu;
  const setVisible = (visible: boolean) => {
    for (const listener of visibilityListeners) listener({ visible });
  };
  return { pinned, setVisible };
}

// A widget with its own control in the top-right corner, where the old floating
// pin button used to sit.
function cornerWidget(id: string, onCorner = vi.fn()): RefreshableBabyMenuWidget {
  return {
    id,
    title: id,
    render: () => (
      <div className="flex items-center justify-between">
        <span>{`${id} value`}</span>
        <button type="button" onClick={onCorner}>
          {`${id} corner`}
        </button>
      </div>
    ),
  };
}

function renderSurface(widgets: RefreshableBabyMenuWidget[]) {
  return render(
    <PinModeProvider>
      <PinModeToggle />
      <WidgetHost widgets={widgets} layout={null} />
    </PinModeProvider>,
  );
}

async function enterPinMode() {
  fireEvent.click(screen.getByRole("button", { name: "pin widgets to desktop" }));
  await screen.findAllByTestId("pin-mode-overlay");
}

afterEach(() => {
  cleanup();
  delete window.babyMenu;
});

describe("pin mode", () => {
  it("draws no pin chrome over widget cards outside pin mode, so a widget's corner control stays clickable", () => {
    installBridge();
    const onCorner = vi.fn();
    renderSurface([cornerWidget("clock", onCorner)]);

    expect(screen.queryByTestId("pin-mode-overlay")).toBeNull();
    expect(screen.queryByRole("button", { name: /pin clock/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "clock corner" }));
    expect(onCorner).toHaveBeenCalledTimes(1);
  });

  it("covers every card with a pin target while active and pins the clicked widget", async () => {
    const { pinned } = installBridge();
    renderSurface([cornerWidget("clock"), cornerWidget("weather")]);

    await enterPinMode();

    expect(screen.getAllByTestId("pin-mode-overlay")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "pin widgets to desktop" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pin clock to desktop" }));

    await waitFor(() => expect(pinned.pin).toHaveBeenCalledWith("clock"));
    expect(await screen.findByRole("button", { name: "unpin clock from desktop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "pin weather to desktop" })).toBeTruthy();
    expect(pinned.unpin).not.toHaveBeenCalled();
  });

  it("shows which widgets are already pinned and unpins them on click", async () => {
    const { pinned } = installBridge(["weather"]);
    renderSurface([cornerWidget("clock"), cornerWidget("weather")]);

    await enterPinMode();
    fireEvent.click(await screen.findByRole("button", { name: "unpin weather from desktop" }));

    await waitFor(() => expect(pinned.unpin).toHaveBeenCalledWith("weather"));
    expect(await screen.findByRole("button", { name: "pin weather to desktop" })).toBeTruthy();
  });

  it("re-reads the pinned list on entry, since a widget can be unpinned from its own window", async () => {
    const pinnedIds = ["clock"];
    const { pinned } = installBridge(pinnedIds);
    renderSurface([cornerWidget("clock")]);

    await enterPinMode();
    expect(await screen.findByRole("button", { name: "unpin clock from desktop" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "pin widgets to desktop" }));
    await waitFor(() => expect(screen.queryByTestId("pin-mode-overlay")).toBeNull());

    pinnedIds.splice(0);
    await enterPinMode();

    expect(await screen.findByRole("button", { name: "pin clock to desktop" })).toBeTruthy();
    expect(pinned.list).toHaveBeenCalledTimes(2);
  });

  it("leaves pin mode on the toggle, on Escape, and when the popover is hidden", async () => {
    const { setVisible } = installBridge();
    renderSurface([cornerWidget("clock")]);

    await enterPinMode();
    fireEvent.click(screen.getByRole("button", { name: "pin widgets to desktop" }));
    expect(screen.queryByTestId("pin-mode-overlay")).toBeNull();

    await enterPinMode();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pin-mode-overlay")).toBeNull();

    await enterPinMode();
    act(() => setVisible(false));
    expect(screen.queryByTestId("pin-mode-overlay")).toBeNull();
  });

  it("marks the built-in getting-started card as not pinnable", async () => {
    const { pinned } = installBridge();
    render(
      <PinModeProvider>
        <PinModeToggle />
        <WidgetHost runtimeImporter={async () => ({})} layout={null} />
      </PinModeProvider>,
    );
    await screen.findByText("hello world");

    await enterPinMode();

    const overlay = screen.getByTestId("pin-mode-overlay");
    expect(overlay.textContent).toMatch(/not pinnable/);
    expect((overlay as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(overlay);
    expect(pinned.pin).not.toHaveBeenCalled();
  });

  it("puts pin targets on cards placed by a custom layout too", async () => {
    installBridge();
    const TwoColumns: BabyMenuLayout = ({ widgets, renderWidget }) => (
      <div className="grid grid-cols-2">
        {widgets.map(({ id }) => (
          <div key={id}>{renderWidget(id)}</div>
        ))}
      </div>
    );
    render(
      <PinModeProvider>
        <PinModeToggle />
        <WidgetHost widgets={[cornerWidget("clock"), cornerWidget("weather")]} layout={TwoColumns} />
      </PinModeProvider>,
    );

    await enterPinMode();

    expect(screen.getByRole("button", { name: "pin clock to desktop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "pin weather to desktop" })).toBeTruthy();
  });

  it("has no toggle when the host cannot pin widgets", () => {
    window.babyMenu = { popover: { onVisibility: vi.fn(() => () => undefined) } } as unknown as typeof window.babyMenu;
    renderSurface([cornerWidget("clock")]);

    expect(screen.queryByRole("button", { name: "pin widgets to desktop" })).toBeNull();
    expect(screen.queryByTestId("pin-mode-overlay")).toBeNull();
  });
});

describe("App header", () => {
  it("offers the pin mode toggle next to the other header controls", () => {
    installBridge();
    Object.assign(window.babyMenu!, {
      agent: { onStatus: vi.fn(() => () => undefined), getActiveTurn: vi.fn(async () => null) },
      git: { status: vi.fn(async () => null) },
      layout: { get: vi.fn(async () => null) },
      background: { onUpdate: vi.fn(() => () => undefined) },
      app: { getUpdateStatus: vi.fn(async () => ({ updateAvailable: false })) },
    });
    render(<App />);

    const toggle = screen.getByRole("button", { name: "pin widgets to desktop" });
    expect(toggle.closest(".pop-head")).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});
