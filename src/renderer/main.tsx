import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PinnedApp, readPinnedWidgetId } from "./PinnedApp";
import * as babyMenuUi from "../ui";
import { installWidgetHostShims } from "./widget-host-shim";
import "../ui/styles.css";
import "./styles.css";

if (import.meta.env.DEV) {
  void import("../ui/styles.dev.css");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

installWidgetHostShims(window, React, jsxRuntime, babyMenuUi);

// A pinned desktop widget window loads this same bundle with `?pinned=<widget id>`
// and shows just that widget; everything else is the tray popover.
const pinnedWidgetId = readPinnedWidgetId(window.location.search);
if (pinnedWidgetId) document.documentElement.dataset.pinned = "";

createRoot(root).render(
  <React.StrictMode>{pinnedWidgetId ? <PinnedApp widgetId={pinnedWidgetId} /> : <App />}</React.StrictMode>,
);
