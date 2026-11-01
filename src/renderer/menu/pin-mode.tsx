import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pin } from "lucide-react";
import { Button, Tooltip, cn } from "../../ui";

// Pin mode is how a popover widget gets pinned to the desktop. Outside it the
// host draws nothing over widget cards, so a widget keeps every pixel of its
// card, corner controls included. The header toggle switches it on; each card is
// then covered by a pin target until the user leaves with the toggle, Escape, or
// by closing the popover.

type PinModeState = {
  // False when the host has no pinning bridge (older hosts, tests).
  available: boolean;
  active: boolean;
  pinnedIds: ReadonlySet<string>;
  setActive: (active: boolean) => void;
  toggle: (widgetId: string) => Promise<void>;
};

const PinModeContext = createContext<PinModeState | null>(null);

export function PinModeProvider({ children }: { children: ReactNode }) {
  const bridge = window.babyMenu?.pinned;
  const [active, setActive] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => new Set());

  // A pinned window can be unpinned from its own corner while the popover is
  // closed, so the list is re-read every time pin mode starts.
  useEffect(() => {
    if (!active || !bridge) return undefined;
    let disposed = false;
    bridge
      .list()
      .then((ids) => {
        if (!disposed) setPinnedIds(new Set(ids));
      })
      .catch((error) => console.error("[baby-menu] failed to read pinned widgets", error));
    return () => {
      disposed = true;
    };
  }, [active, bridge]);

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const unsubscribe = window.babyMenu?.popover?.onVisibility?.(({ visible }) => {
      if (!visible) setActive(false);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribe?.();
    };
  }, [active]);

  const toggle = useCallback(
    async (widgetId: string) => {
      if (!bridge) return;
      try {
        const ids = await (pinnedIds.has(widgetId) ? bridge.unpin(widgetId) : bridge.pin(widgetId));
        setPinnedIds(new Set(ids));
      } catch (error) {
        console.error("[baby-menu] failed to change widget pin", error);
      }
    },
    [bridge, pinnedIds],
  );

  const value = useMemo(
    () => ({ available: Boolean(bridge), active, pinnedIds, setActive, toggle }),
    [bridge, active, pinnedIds, toggle],
  );
  return <PinModeContext.Provider value={value}>{children}</PinModeContext.Provider>;
}

export function PinModeToggle() {
  const pinMode = useContext(PinModeContext);
  if (!pinMode?.available) return null;
  const { active, setActive } = pinMode;

  return (
    <Tooltip content={active ? "Done pinning" : "Pin widgets to desktop"}>
      <Button
        variant="ghost"
        size="sm"
        className={cn("w-7 px-0", active && "bg-pressed text-ink-strong")}
        aria-label="pin widgets to desktop"
        aria-pressed={active}
        onClick={() => setActive(!active)}
      >
        <Pin className="size-4" />
      </Button>
    </Tooltip>
  );
}

// The pin target laid over one widget card while pin mode is on. `pinnable` is
// false for cards a pinned window could never load again (the built-in
// getting-started card).
export function PinModeOverlay({ widgetId, title, pinnable }: { widgetId: string; title: string; pinnable: boolean }) {
  const pinMode = useContext(PinModeContext);
  if (!pinMode?.active) return null;

  if (!pinnable) {
    return (
      <button type="button" className="pin-mode-overlay" data-testid="pin-mode-overlay" disabled>
        <span className="text-ink-label">not pinnable</span>
      </button>
    );
  }

  const pinned = pinMode.pinnedIds.has(widgetId);
  return (
    <button
      type="button"
      className="pin-mode-overlay"
      data-testid="pin-mode-overlay"
      aria-label={pinned ? `unpin ${title} from desktop` : `pin ${title} to desktop`}
      onClick={() => void pinMode.toggle(widgetId)}
    >
      {pinned ? (
        <>
          <span className="pin-mode-dot" aria-hidden="true" />
          <span className="text-ink-strong">pinned</span>
          <span className="text-ink-label">· unpin</span>
        </>
      ) : (
        <span className="text-ink-strong">› pin to desktop</span>
      )}
    </button>
  );
}
