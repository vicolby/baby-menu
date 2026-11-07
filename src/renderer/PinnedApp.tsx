import { PinOff } from "lucide-react";
import type { RefreshableBabyMenuWidget } from "../shared/contracts";
import { PINNED_WIDGET_WIDTH } from "../shared/pinned-widget";
import { Button, Tooltip } from "../ui";
import { WidgetCard, useRuntimeWidgetList, type RuntimeWidgetImporter } from "./menu/WidgetHost";
import { measurePopoverContentHeight } from "./popover-content-height";
import { usePopoverContentSize } from "./use-popover-content-size";

// A pinned desktop widget window loads the normal renderer with `?pinned=<id>`.
export function readPinnedWidgetId(search: string): string | null {
  const id = new URLSearchParams(search).get("pinned");
  return id ? id : null;
}

// Pinned widgets keep one fixed width (their height follows the content), so a
// widget lays out the same way every time instead of stretching with its window.
function measurePinnedContentSize(shell: HTMLElement) {
  return { width: PINNED_WIDGET_WIDTH, height: measurePopoverContentHeight(shell) };
}

type PinnedAppProps = {
  widgetId: string;
  // Test/override hooks, mirroring WidgetHost: bypass runtime discovery.
  widgets?: RefreshableBabyMenuWidget[];
  runtimeImporter?: RuntimeWidgetImporter;
};

export function PinnedApp({ widgetId, widgets, runtimeImporter }: PinnedAppProps) {
  usePopoverContentSize(measurePinnedContentSize);
  const discovered = useRuntimeWidgetList({ enabled: widgets === undefined, importer: runtimeImporter });
  const available = widgets ?? discovered.widgets;
  const loaded = widgets !== undefined || discovered.loaded;
  const widget = available.find((candidate) => candidate.id === widgetId);

  return (
    <main className="app-shell pinned-shell" aria-label={`pinned widget ${widgetId}`}>
      <div className="pinned-handle">
        <span className="pinned-grip" aria-hidden="true">{"···"}</span>
        <Tooltip content="Unpin from desktop">
          <Button
            variant="ghost"
            size="sm"
            className="pinned-unpin h-[18px] w-5 px-0"
            aria-label="unpin from desktop"
            onClick={() => void window.babyMenu?.pinned.unpin(widgetId)}
          >
            <PinOff className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
      <div className="pop-body pinned-body">
        {widget ? (
          <WidgetCard widget={widget} />
        ) : loaded ? (
          <p className="pinned-missing">{`Widget "${widgetId}" is not installed.`}</p>
        ) : null}
      </div>
    </main>
  );
}
