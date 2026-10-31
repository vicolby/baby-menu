import { useEffect, useRef, useState } from "react";
import { Power, RotateCw, Settings, X } from "lucide-react";
import { Button, Tooltip } from "../ui";
import { AgentChat } from "./agent/AgentChat";
import { MenuSurface } from "./menu/MenuSurface";
import { SettingsView } from "./settings/SettingsView";
import { usePopoverContentSize } from "./use-popover-content-size";
import { UpdateIndicator } from "./UpdateIndicator";

type AppView = "menu" | "settings";

export function App() {
  const [view, setView] = useState<AppView>("menu");
  // Bumping this remounts the menu surface, forcing widget + layout discovery to
  // re-run and resetting all widget React state - a manual full layout reload.
  const [reloadNonce, setReloadNonce] = useState(0);
  const shellRef = useRef<HTMLElement>(null);
  usePopoverContentSize();
  useDropHeaderAutoFocus();

  const settingsOpen = view === "settings";

  function openSettings() {
    setView("settings");
  }

  function closeSettings() {
    setView("menu");
  }

  function reloadLayout() {
    setReloadNonce((nonce) => nonce + 1);
  }

  function quitApp() {
    void window.babyMenu?.app.quit();
  }

  return (
    <main ref={shellRef} className="app-shell" aria-label="baby_menu tray popover">
      {/* The default view stays mounted underneath settings so its React state
          (agent chat, widgets) survives opening and closing settings. It is made
          inert while covered so focus and pointer events cannot reach behind the
          overlay. */}
      <div className="app-view" inert={settingsOpen}>
        <header className="pop-head">
          <span className="mark">
            baby<span className="sep">_</span>menu
          </span>
          <div className="flex items-center gap-1">
            <UpdateIndicator />
            <Tooltip content="Reload layout">
              <Button
                variant="ghost"
                size="sm"
                className="w-7 px-0"
                aria-label="reload layout"
                onClick={reloadLayout}
              >
                <RotateCw className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Open settings">
              <Button variant="ghost" size="sm" className="w-7 px-0" aria-label="open settings" onClick={openSettings}>
                <Settings className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Quit baby menu">
              <Button
                variant="ghost"
                size="sm"
                className="w-7 px-0 hover:text-signal-danger"
                aria-label="quit baby_menu"
                onClick={quitApp}
              >
                <Power className="size-4" />
              </Button>
            </Tooltip>
          </div>
        </header>
        <div className="pop-body">
          <MenuSurface key={reloadNonce} />
        </div>
        <AgentChat />
      </div>

      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="settings">
          <header className="pop-head">
            <span className="mark">settings</span>
            <Tooltip content="Close settings">
              <Button variant="ghost" size="sm" className="w-7 px-0" aria-label="close settings" onClick={closeSettings}>
                <X className="size-4" />
              </Button>
            </Tooltip>
          </header>
          <div className="pop-body">
            <SettingsView />
          </div>
        </div>
      ) : null}
    </main>
  );
}

// The popover opens focused (main calls window.focus()); if that focus lands on a
// header control it gets ring-highlighted before the user does anything. Clear
// that auto-focus without touching genuine keyboard focus elsewhere.
function useDropHeaderAutoFocus() {
  useEffect(() => {
    const drop = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active && active.closest(".pop-head")) active.blur();
      });
    };
    drop();
    window.addEventListener("focus", drop);
    return () => window.removeEventListener("focus", drop);
  }, []);
}
