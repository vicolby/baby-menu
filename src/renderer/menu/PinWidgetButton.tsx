import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { Button, Tooltip } from "../../ui";

// Pins a widget to the desktop (or unpins it). Renders nothing when the host
// bridge has no pinning support, so older hosts and tests see no extra chrome.
export function PinWidgetButton({ widgetId, title }: { widgetId: string; title: string }) {
  const bridge = window.babyMenu?.pinned;
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!bridge) return undefined;
    let disposed = false;
    // A pinned window can be unpinned from its own corner while the popover is
    // closed, so re-read whenever the popover is shown again.
    const sync = () => {
      bridge
        .list()
        .then((ids) => {
          if (!disposed) setPinned(ids.includes(widgetId));
        })
        .catch(() => undefined);
    };
    sync();
    const unsubscribe = window.babyMenu?.popover?.onVisibility?.(({ visible }) => {
      if (visible) sync();
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge, widgetId]);

  if (!bridge) return null;

  const label = pinned ? `unpin ${title} from desktop` : `pin ${title} to desktop`;
  const Icon = pinned ? PinOff : Pin;

  async function toggle() {
    try {
      const ids = await (pinned ? bridge!.unpin(widgetId) : bridge!.pin(widgetId));
      setPinned(ids.includes(widgetId));
    } catch (error) {
      console.error("[baby-menu] failed to change widget pin", error);
    }
  }

  return (
    <Tooltip content={pinned ? "Unpin from desktop" : "Pin to desktop"}>
      <Button variant="ghost" size="sm" className="w-7 px-0" aria-label={label} onClick={() => void toggle()}>
        <Icon className="size-4" />
      </Button>
    </Tooltip>
  );
}
