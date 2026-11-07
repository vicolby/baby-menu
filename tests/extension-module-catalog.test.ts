import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileExtensionModule } from "../src/main/extension-module-compiler";
import {
  EXTENSION_MODULE_STAT_INTERVAL_MS,
  createExtensionModuleCatalog,
  type ExtensionModuleCatalog,
} from "../src/main/extension-module-catalog";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  app: {
    quit: vi.fn(),
    getVersion: () => "0.0.0",
  },
}));

const WIDGET_SOURCE = `export const cpuTempWidget = { id: "cpu-temp", title: "CPU", render: () => "version-one" };\n`;
const WIDGET_SOURCE_EDITED = `export const cpuTempWidget = { id: "cpu-temp", title: "CPU", render: () => "version-two" };\n`;
const LAYOUT_SOURCE = `export default function Layout() { return null; }\n`;

describe("extension module catalog", () => {
  const tempDirs: string[] = [];
  const catalogs: ExtensionModuleCatalog[] = [];

  afterEach(async () => {
    for (const catalog of catalogs.splice(0)) catalog.stop();
    handlers.clear();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps the mtime check inside a 30-60 second cadence", () => {
    expect(EXTENSION_MODULE_STAT_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(EXTENSION_MODULE_STAT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it("does not transpile a repeat widgets.list() when nothing on disk changed", async () => {
    const { rootDir, extensionsDir, widgetCacheDir } = await createWorkspace();
    const compile = vi.fn(compileExtensionModule);
    const catalog = createExtensionModuleCatalog({
      rootDir,
      extensionsDir,
      mode: "compiled",
      widgetCacheDir,
      compile,
    });
    catalogs.push(catalog);
    const { registerIpcHandlers } = await import("../src/main/ipc");
    registerIpcHandlers(
      rootDir,
      agentRuntime(),
      { list: async () => [], invoke: async () => undefined },
      catalog,
      undefined,
      undefined,
      undefined,
      { layoutModules: catalog },
    );

    const list = () => handlers.get("baby-menu:widgets:list")?.({});
    const getLayout = () => handlers.get("baby-menu:layout:get")?.({});

    const [firstWidgets, concurrentWidgets] = await Promise.all([list(), list()]);
    const firstLayout = await getLayout();

    expect(firstWidgets).toEqual(concurrentWidgets);
    expect(firstLayout).toMatchObject({ moduleUrl: expect.stringMatching(/^baby-menu-widget:\/\/__layout\//) });
    // One compile for the widget and one for the layout, shared by the concurrent lists.
    expect(compile).toHaveBeenCalledTimes(2);

    await expect(list()).resolves.toEqual(firstWidgets);
    await expect(getLayout()).resolves.toEqual(firstLayout);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("does not transpile while the mtime check runs against an unchanged tree", async () => {
    const { rootDir, extensionsDir, widgetCacheDir } = await createWorkspace();
    const compile = vi.fn(compileExtensionModule);
    const catalog = createExtensionModuleCatalog({
      rootDir,
      extensionsDir,
      mode: "compiled",
      widgetCacheDir,
      compile,
      statIntervalMs: 40,
      watchDebounceMs: 20,
    });
    catalogs.push(catalog);

    await catalog.list();
    expect(compile).toHaveBeenCalledTimes(2);
    catalog.start();

    await delay(200);

    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("recompiles a packaged widget after its file changes and tells listeners without transpiling first", async () => {
    // Same packaged-pipeline check as tests/widget-pipeline-integration.test.ts:
    // compile the widget, then read the emitted module back off disk.
    const { rootDir, extensionsDir, widgetCacheDir, widgetFile } = await createWorkspace({ symlink: true });
    const compile = vi.fn(compileExtensionModule);
    const changed = vi.fn();
    const catalog = createExtensionModuleCatalog({
      rootDir,
      extensionsDir,
      mode: "compiled",
      widgetCacheDir,
      compile,
      statIntervalMs: 40,
      watchDebounceMs: 20,
    });
    catalogs.push(catalog);
    catalog.onChanged(changed);

    const [first] = await catalog.list();
    expect(first?.moduleUrl).toMatch(/^baby-menu-widget:\/\/cpu-temp\/[a-f0-9]{16}\/widget\.mjs$/);
    expect(compile).toHaveBeenCalledTimes(2);

    catalog.start();
    await delay(50);
    compile.mockClear();
    changed.mockClear();

    await writeFile(widgetFile, WIDGET_SOURCE_EDITED);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 4_000, interval: 10 });
    expect(compile).not.toHaveBeenCalled();

    const [second] = await catalog.list();
    expect(compile).toHaveBeenCalled();
    expect(second?.moduleUrl).not.toBe(first?.moduleUrl);

    const compiled = await readFile(cachePath(widgetCacheDir, second!.moduleUrl), "utf8");
    expect(compiled).toContain("version-two");
    expect(compiled).not.toContain("version-one");
  });

  async function createWorkspace(options: { symlink?: boolean } = {}) {
    const rootDir = await mkdtemp(join(tmpdir(), "baby-menu-module-catalog-"));
    tempDirs.push(rootDir);
    const realExtensionsDir = join(rootDir, "real-extensions");
    const widgetDir = join(realExtensionsDir, "cpu-temp");
    await mkdir(widgetDir, { recursive: true });
    const widgetFile = join(widgetDir, "widget.tsx");
    await writeFile(widgetFile, WIDGET_SOURCE);
    await writeFile(join(realExtensionsDir, "layout.tsx"), LAYOUT_SOURCE);
    const extensionsDir = options.symlink ? join(rootDir, "extensions") : realExtensionsDir;
    if (options.symlink) await symlink(realExtensionsDir, extensionsDir);
    return { rootDir, extensionsDir, widgetCacheDir: join(rootDir, "cache", "widgets"), widgetFile };
  }
});

function cachePath(widgetCacheDir: string, protocolUrl: string): string {
  return join(widgetCacheDir, protocolUrl.replace("baby-menu-widget://", ""));
}

function agentRuntime() {
  return {
    send: vi.fn(),
    save: vi.fn(),
    rollback: vi.fn(),
    currentSessionSnapshot: vi.fn(),
    currentTurn: vi.fn(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
