// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshableBabyMenuWidget } from "../src/shared/contracts";
import { PINNED_WIDGET_WIDTH } from "../src/shared/pinned-widget";
import { PinnedApp, readPinnedWidgetId } from "../src/renderer/PinnedApp";

function widget(id: string, overrides: Partial<RefreshableBabyMenuWidget> = {}): RefreshableBabyMenuWidget {
  return { id, title: `${id} title`, render: () => <p>{`body of ${id}`}</p>, ...overrides } as RefreshableBabyMenuWidget;
}

function installBridge(pinnedIds: string[] = []) {
  const pinned = {
    list: vi.fn(async () => [...pinnedIds]),
    pin: vi.fn(async (id: string) => {
      pinnedIds.push(id);
      return [...pinnedIds];
    }),
    unpin: vi.fn(async (id: string) => {
      pinnedIds.splice(pinnedIds.indexOf(id), 1);
      return [...pinnedIds];
    }),
  };
  const popover = {
    setContentSize: vi.fn(async () => ({ ok: true })),
    getVisibility: vi.fn(async () => ({ visible: true })),
    onVisibility: vi.fn(() => () => undefined),
  };
  window.babyMenu = { pinned, popover } as unknown as typeof window.babyMenu;
  return { pinned, popover };
}

afterEach(() => {
  cleanup();
  delete window.babyMenu;
  vi.restoreAllMocks();
});

describe("readPinnedWidgetId", () => {
  it("reads the widget id from the page query", () => {
    expect(readPinnedWidgetId("?pinned=clock")).toBe("clock");
    expect(readPinnedWidgetId("?debug=1&pinned=my%20widget")).toBe("my widget");
  });

  it("is null for the normal popover page and for an empty id", () => {
    expect(readPinnedWidgetId("")).toBeNull();
    expect(readPinnedWidgetId("?debug=1")).toBeNull();
    expect(readPinnedWidgetId("?pinned=")).toBeNull();
  });
});

describe("PinnedApp", () => {
  it("renders only the pinned widget, without the popover chrome", () => {
    installBridge();

    const { getByText, queryByText, queryByLabelText } = render(
      <PinnedApp widgetId="clock" widgets={[widget("clock"), widget("weather")]} />,
    );

    expect(getByText("body of clock")).not.toBeNull();
    expect(queryByText("body of weather")).toBeNull();
    expect(queryByLabelText("open settings")).toBeNull();
    expect(queryByLabelText("quit baby_menu")).toBeNull();
  });

  it("unpins the widget from its own window", () => {
    const { pinned } = installBridge(["clock"]);
    const { getByLabelText } = render(<PinnedApp widgetId="clock" widgets={[widget("clock")]} />);

    fireEvent.click(getByLabelText("unpin from desktop"));

    expect(pinned.unpin).toHaveBeenCalledWith("clock");
  });

  it("marks the drag strip with a grip that is not the unpin control", () => {
    const { pinned } = installBridge(["clock"]);
    const { container, getByLabelText } = render(<PinnedApp widgetId="clock" widgets={[widget("clock")]} />);

    const grip = container.querySelector(".pinned-handle .pinned-grip");
    expect(grip?.textContent).toBe("···");
    expect(grip?.getAttribute("aria-hidden")).toBe("true");
    const unpin = getByLabelText("unpin from desktop");
    expect(unpin.contains(grip)).toBe(false);
    expect(grip?.closest("button")).toBeNull();

    fireEvent.click(unpin);

    expect(pinned.unpin).toHaveBeenCalledWith("clock");
  });

  it("says so, and still lets the user unpin, when the widget no longer exists", () => {
    installBridge(["gone"]);

    const { getByText, getByLabelText } = render(<PinnedApp widgetId="gone" widgets={[widget("clock")]} />);

    expect(getByText(/gone/)).not.toBeNull();
    expect(getByLabelText("unpin from desktop")).not.toBeNull();
  });

  it("shows nothing, not the missing message, while widgets are still loading", async () => {
    installBridge(["clock"]);
    let resolveModule: (module: unknown) => void = () => undefined;
    const importer = vi.fn(() => new Promise<unknown>((resolve) => void (resolveModule = resolve)));
    window.babyMenu = {
      ...window.babyMenu,
      widgets: { list: vi.fn(async () => [{ id: "clock.widget", extensionId: "clock", moduleUrl: "/clock.js" }]) },
    } as unknown as typeof window.babyMenu;

    const { queryByText, findByText } = render(<PinnedApp widgetId="clock" runtimeImporter={importer} />);

    expect(queryByText(/not installed/i)).toBeNull();
    await waitFor(() => expect(importer).toHaveBeenCalled());
    await act(async () => resolveModule({ clock: widget("clock") }));
    expect(await findByText("body of clock")).not.toBeNull();
  });

  it("asks main to size its window to the fixed pinned width and the content height", async () => {
    const { popover } = installBridge();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 187,
      width: 100,
      height: 187,
      toJSON: () => ({}),
    });

    render(<PinnedApp widgetId="clock" widgets={[widget("clock")]} />);

    await waitFor(() => expect(popover.setContentSize).toHaveBeenCalledWith({ width: PINNED_WIDGET_WIDTH, height: 187 }));
  });

  it("refreshes the pinned widget even though the popover is closed", () => {
    installBridge();
    const refreshView = vi.fn();

    render(<PinnedApp widgetId="clock" widgets={[widget("clock", { refreshView })]} />);

    return waitFor(() => expect(refreshView).toHaveBeenCalled());
  });
});
