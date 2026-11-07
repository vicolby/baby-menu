/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetHost } from "../src/renderer/menu/WidgetHost";
import type { BabyMenuApi, RefreshableBabyMenuWidget } from "../src/shared/contracts";

function installBabyMenuApi(widgets: BabyMenuApi["widgets"]) {
  window.babyMenu = {
    recipes: { list: vi.fn(async () => []) },
    git: {
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => null),
    },
    agent: {
      send: vi.fn(async () => ({ assistantText: "done" })),
      onStatus: vi.fn(() => () => undefined),
      getActiveTurn: vi.fn(async () => null),
    },
    capabilities: {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => undefined) as BabyMenuApi["capabilities"]["invoke"],
    },
    db: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
      exec: vi.fn(async () => undefined),
    },
    widgets,
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [] })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [] })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [] })),
    },
    pinned: {
      list: vi.fn(async () => []),
      pin: vi.fn(async () => []),
      unpin: vi.fn(async () => []),
    },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };
}

afterEach(() => {
  cleanup();
  delete window.babyMenu;
  vi.useRealTimers();
});

describe("WidgetHost", () => {
  it("loads runtime widgets and hides the hello-world fallback", async () => {
    const cpuWidget: RefreshableBabyMenuWidget = {
      id: "cpu-temp",
      title: "CPU TEMP",
      render: () => <span>42c</span>,
    };
    installBabyMenuApi({
      list: vi.fn(async () => [
        { id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" },
      ]),
    });

    render(<WidgetHost runtimeImporter={async () => ({ cpuWidget })} />);

    expect(await screen.findByText("42c")).toBeTruthy();
    expect(screen.queryByText("hello world")).toBeNull();
  });

  it("shows hello-world when no runtime widgets are discovered", async () => {
    installBabyMenuApi({ list: vi.fn(async () => []) });

    render(<WidgetHost runtimeImporter={async () => ({})} />);

    expect(await screen.findByText("hello world")).toBeTruthy();
  });

  it("reloads widgets and layout when modules change, not on a timer or when the popover opens", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const cpuWidget: RefreshableBabyMenuWidget = {
      id: "cpu-temp",
      title: "CPU TEMP",
      render: () => <span>42c</span>,
    };
    const list = vi.fn(async () => [
      { id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" },
    ]);
    const moduleListeners = new Set<() => void>();
    const visibilityListeners = new Set<(state: { visible: boolean }) => void>();
    installBabyMenuApi({
      list,
      onModulesChanged: (listener) => {
        moduleListeners.add(listener);
        return () => {
          moduleListeners.delete(listener);
        };
      },
    });
    const getLayout = vi.mocked(window.babyMenu!.layout.get);
    window.babyMenu!.popover.onVisibility = (listener) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    };

    render(<WidgetHost runtimeImporter={async () => ({ cpuWidget })} />);

    expect(await screen.findByText("42c")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    expect(getLayout).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(getLayout).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of moduleListeners) listener();
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(getLayout).toHaveBeenCalledTimes(2);

    await act(async () => {
      for (const listener of visibilityListeners) listener({ visible: false });
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(getLayout).toHaveBeenCalledTimes(2);

    await act(async () => {
      for (const listener of visibilityListeners) listener({ visible: true });
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(getLayout).toHaveBeenCalledTimes(2);
  });
});
