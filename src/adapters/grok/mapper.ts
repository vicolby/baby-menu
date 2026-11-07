import type * as schema from "@agentclientprotocol/sdk";
import { providerTurnError, type MapResult } from "../shared/types.js";

/**
 * Pure mapping from one `grok -p --output-format streaming-json` line to ACP
 * session updates. Shapes are from grok 1.0.77: text arrives as incremental
 * `text` chunks, file writes use `kind: "write"` (not an ACP tool kind), and
 * the turn ends on `type: "end"` (or `type: "error"`).
 *
 * `usage`, `available_commands`, and `plan` carry no chat content. `usage`
 * also carries a provider signature, so it is never forwarded.
 */
export type GrokStreamEvent = {
  type?: string;
  data?: string;
  message?: string;
  stopReason?: string;
  sessionId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  toolName?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: unknown;
};

const TOOL_KINDS = new Set<schema.ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const TOOL_STATUSES = new Set<schema.ToolCallStatus>(["pending", "in_progress", "completed", "failed"]);

const STOP_REASONS = new Set<schema.StopReason>(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

const EMPTY: MapResult = { updates: [] };

export function mapGrokEvent(event: GrokStreamEvent): MapResult {
  switch (event.type) {
    case "text":
      return event.data
        ? { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.data } }] }
        : EMPTY;
    case "thought":
      return event.data
        ? { updates: [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.data } }] }
        : EMPTY;
    case "tool_call":
      return mapToolCall(event);
    case "tool_call_update":
      return mapToolCallUpdate(event);
    case "end":
      return { updates: [], stopReason: mapStopReason(event.stopReason) };
    case "error":
      return { updates: [], terminalError: providerTurnError("Grok", event.message) };
    default:
      return EMPTY;
  }
}

function mapToolCall(event: GrokStreamEvent): MapResult {
  if (!event.toolCallId) return EMPTY;
  const content = toolContent(event.content);
  const locations = toolLocations(event.locations);
  return {
    updates: [
      {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: event.title || event.toolName || "tool",
        kind: toolKind(event.kind, event.toolName),
        status: toolStatus(event.status) ?? "in_progress",
        rawInput: rawInput(event.rawInput),
        ...(content ? { content } : {}),
        ...(locations ? { locations } : {}),
      },
    ],
  };
}

function mapToolCallUpdate(event: GrokStreamEvent): MapResult {
  if (!event.toolCallId) return EMPTY;
  const content = toolContent(event.content);
  const locations = toolLocations(event.locations);
  const status = toolStatus(event.status);
  return {
    updates: [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        ...(status ? { status } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(content ? { content } : {}),
        ...(locations ? { locations } : {}),
      },
    ],
  };
}

function mapStopReason(reason: string | undefined): schema.StopReason {
  return reason && STOP_REASONS.has(reason as schema.StopReason) ? (reason as schema.StopReason) : "end_turn";
}

function toolKind(kind: string | undefined, toolName: string | undefined): schema.ToolKind {
  if (kind && TOOL_KINDS.has(kind as schema.ToolKind)) return kind as schema.ToolKind;
  const name = `${kind ?? ""} ${toolName ?? ""}`.toLowerCase();
  if (/\b(write|edit|search_replace|strreplace)\b/.test(name)) return "edit";
  if (name.includes("delete")) return "delete";
  if (name.includes("read")) return "read";
  if (/\b(grep|glob|search)\b/.test(name)) return "search";
  if (/\b(bash|shell|terminal)\b/.test(name)) return "execute";
  if (/\b(fetch|web)\b/.test(name)) return "fetch";
  return "other";
}

function toolStatus(status: string | undefined): schema.ToolCallStatus | undefined {
  return status && TOOL_STATUSES.has(status as schema.ToolCallStatus) ? (status as schema.ToolCallStatus) : undefined;
}

function rawInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toolContent(content: unknown): schema.ToolCallContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const updates: schema.ToolCallContent[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "diff" && typeof block.path === "string" && typeof block.newText === "string") {
      updates.push({
        type: "diff",
        path: block.path,
        newText: block.newText,
        ...(typeof block.oldText === "string" || block.oldText === null ? { oldText: block.oldText } : {}),
      });
      continue;
    }
    if (block.type === "content" && block.content && typeof block.content === "object") {
      const inner = block.content as { type?: unknown; text?: unknown };
      if (inner.type === "text" && typeof inner.text === "string") {
        updates.push({ type: "content", content: { type: "text", text: inner.text } });
      }
    }
  }
  return updates.length > 0 ? updates : undefined;
}

function toolLocations(locations: unknown): schema.ToolCallLocation[] | undefined {
  if (!Array.isArray(locations)) return undefined;
  const parsed = locations.filter(
    (location): location is schema.ToolCallLocation =>
      !!location && typeof location === "object" && typeof (location as { path?: unknown }).path === "string",
  );
  return parsed.length > 0 ? parsed : undefined;
}
