import { watch, type Dirent, type FSWatcher, type Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { BabyMenuLayoutModuleDescriptor, BabyMenuWidgetModuleDescriptor } from "../shared/contracts";
import { getExtensionsDir } from "../shared/paths";
import {
  discoverLayoutModule,
  discoverWidgetModules,
  type DiscoverWidgetModulesOptions,
  type LayoutModuleRegistry,
  type WidgetModuleRegistry,
} from "./widget-module-registry";

// Slow enough that an idle menu does not stat the workspace in a tight loop, and
// frequent enough that a missed fs.watch event still shows up inside a minute.
export const EXTENSION_MODULE_STAT_INTERVAL_MS = 45_000;

const DEFAULT_WATCH_DEBOUNCE_MS = 300;
const MAX_COMPILE_ATTEMPTS = 3;
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

export type ExtensionModuleCatalogOptions = DiscoverWidgetModulesOptions & {
  watchDebounceMs?: number;
  statIntervalMs?: number;
};

export type ExtensionModuleCatalog = WidgetModuleRegistry &
  LayoutModuleRegistry & {
    start: () => void;
    stop: () => void;
    onChanged: (listener: () => void) => () => void;
  };

type Snapshot = {
  widgets: BabyMenuWidgetModuleDescriptor[];
  layout: BabyMenuLayoutModuleDescriptor | null;
  fingerprint: string;
};

// Caches widget and layout descriptors for the process. Repeat list/get calls
// with no disk change return the cache and do not transpile. fs.watch invalidates
// that cache, but on macOS it can miss writes that land through some symlinks
// (home-manager, Nix), so a debounced watch is paired with a cheap mtime/size
// walk that never compiles.
export function createExtensionModuleCatalog(options: ExtensionModuleCatalogOptions): ExtensionModuleCatalog {
  const resolvedExtensionsDir = resolve(options.extensionsDir ?? getExtensionsDir(options.rootDir));
  const discoverOptions: DiscoverWidgetModulesOptions = {
    rootDir: options.rootDir,
    extensionsDir: resolvedExtensionsDir,
    mode: options.mode,
    widgetCacheDir: options.widgetCacheDir,
    compile: options.compile,
  };
  const debounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const statIntervalMs = options.statIntervalMs ?? EXTENSION_MODULE_STAT_INTERVAL_MS;

  const listeners = new Set<() => void>();
  let snapshot: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;
  let started = false;
  let watchGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let statTimer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let checkAgain = false;
  const watchers: FSWatcher[] = [];

  function notifyChanged(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[baby-menu] extension module listener failed", error);
      }
    }
  }

  async function loadSnapshot(attempt = 0): Promise<Snapshot> {
    const before = await extensionTreeFingerprint(resolvedExtensionsDir);
    const widgets = await discoverWidgetModules(discoverOptions);
    const layout = await discoverLayoutModule(discoverOptions);
    const after = await extensionTreeFingerprint(resolvedExtensionsDir);
    // A write landed while we were compiling. Compile again so the cached
    // descriptors match the tree we are about to publish.
    if (before !== after && attempt + 1 < MAX_COMPILE_ATTEMPTS) return loadSnapshot(attempt + 1);
    const value = { widgets, layout, fingerprint: after };
    snapshot = value;
    return value;
  }

  async function readSnapshot(): Promise<Snapshot> {
    const fingerprint = await extensionTreeFingerprint(resolvedExtensionsDir);
    if (snapshot && snapshot.fingerprint === fingerprint) return snapshot;

    const hadSnapshot = snapshot !== null;
    let current = pending;
    const ownsLoad = current === null;
    if (!current) {
      current = loadSnapshot().finally(() => {
        if (pending === current) pending = null;
      });
      pending = current;
    }
    const loaded = await current;
    // The caller already has the fresh descriptors. Other renderers still need
    // the shared signal, because nothing polls for it.
    if (ownsLoad && hadSnapshot) notifyChanged();
    return loaded;
  }

  async function checkForChanges(): Promise<void> {
    if (!started) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      // Already invalidated, or not loaded yet. The next list() compiles once
      // and picks up every edit that landed in the meantime.
      if (!snapshot) return;
      const fingerprint = await extensionTreeFingerprint(resolvedExtensionsDir);
      if (!started || !snapshot || snapshot.fingerprint === fingerprint) return;
      snapshot = null;
      notifyChanged();
    } catch (error) {
      console.error("[baby-menu] extension module check failed", error);
    } finally {
      checking = false;
      if (checkAgain) {
        checkAgain = false;
        void checkForChanges();
      }
    }
  }

  function scheduleCheck(): void {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!started) return;
      void checkForChanges();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  async function armWatchers(): Promise<void> {
    const generation = watchGeneration;
    const targets = new Set<string>([resolvedExtensionsDir]);
    try {
      targets.add(await realpath(resolvedExtensionsDir));
    } catch {
      // Missing directory: the stat interval notices when it appears.
    }
    if (generation !== watchGeneration || !started) return;

    for (const target of targets) {
      if (generation !== watchGeneration || !started) return;
      try {
        const watcher = watch(target, { recursive: true }, () => scheduleCheck());
        if (generation !== watchGeneration || !started) {
          watcher.close();
          return;
        }
        watchers.push(watcher);
      } catch {
        // recursive fs.watch is not available everywhere, and macOS can miss
        // writes through a symlink. The stat interval covers both.
      }
    }
  }

  return {
    list: async () => (await readSnapshot()).widgets,
    get: async () => (await readSnapshot()).layout,
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      statTimer = setInterval(() => {
        void checkForChanges();
      }, statIntervalMs);
      statTimer.unref?.();
      void armWatchers();
    },
    stop() {
      if (!started) return;
      started = false;
      watchGeneration += 1;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (statTimer) clearInterval(statTimer);
      statTimer = null;
      checking = false;
      checkAgain = false;
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}

// Size plus mtime of every file under the extensions directory. This is the
// cheap change detector: it never reads source and never transpiles.
async function extensionTreeFingerprint(extensionsDir: string): Promise<string> {
  const root = resolve(extensionsDir);
  try {
    await stat(root);
  } catch {
    return "missing";
  }

  const records: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(realDir)) return;
    seen.add(realDir);

    let entries: Dirent[];
    try {
      entries = await readdir(realDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(realDir, entry.name);
        let details: Stats;
        try {
          details = await stat(entryPath);
        } catch {
          records.push(`${displayPath(root, entryPath)}:missing`);
          return;
        }
        if (details.isDirectory()) {
          if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return;
          await walk(entryPath);
          return;
        }
        records.push(`${displayPath(root, entryPath)}:${details.size}:${details.mtimeMs}`);
      }),
    );
  }

  await walk(root);
  records.sort();
  return records.join("\n");
}

function displayPath(root: string, filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}
