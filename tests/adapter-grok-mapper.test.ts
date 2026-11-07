import { describe, expect, it } from "vitest";
import { mapGrokEvent } from "../src/adapters/grok/mapper";

describe("mapGrokEvent", () => {
  it("ignores usage, available_commands, and plan lines", () => {
    expect(mapGrokEvent({ type: "usage", data: "signature-secret" }).updates).toEqual([]);
    expect(mapGrokEvent({ type: "available_commands" }).updates).toEqual([]);
    expect(mapGrokEvent({ type: "plan" }).updates).toEqual([]);
  });

  it("maps text and thought chunks", () => {
    expect(mapGrokEvent({ type: "text", data: "pong" }).updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
    ]);
    expect(mapGrokEvent({ type: "thought", data: "checking" }).updates).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } },
    ]);
  });

  it("maps grok's write tool kind onto ACP edit and drops diff metadata", () => {
    const result = mapGrokEvent({
      type: "tool_call",
      toolCallId: "call-1",
      title: "write",
      kind: "write",
      status: "pending",
      toolName: "write",
      rawInput: { file_path: "hello.txt", content: "hi" },
    });
    expect(result.updates).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "write",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: "hello.txt", content: "hi" },
      },
    ]);

    const update = mapGrokEvent({
      type: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { ok: true },
      content: [{ type: "diff", path: "hello.txt", oldText: "", newText: "hi", _meta: { details: [{ secret: true }] } }],
    });
    expect(update.updates).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { ok: true },
        content: [{ type: "diff", path: "hello.txt", oldText: "", newText: "hi" }],
      },
    ]);
  });

  it("omits a tool update status grok has not set yet", () => {
    const result = mapGrokEvent({
      type: "tool_call_update",
      toolCallId: "call-1",
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    });
    expect(result.updates[0]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    });
  });

  it("ends the turn from the end line and classifies an auth error without the raw message", () => {
    expect(mapGrokEvent({ type: "end", stopReason: "max_turn_requests" }).stopReason).toBe("max_turn_requests");
    expect(mapGrokEvent({ type: "end" }).stopReason).toBe("end_turn");

    const failure = mapGrokEvent({
      type: "error",
      message: "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
    });
    expect(failure.terminalError).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Grok is not authenticated. Run `grok login` and try again.",
    });
    expect(failure.terminalError?.message).not.toMatch(/device-code/);
  });
});
