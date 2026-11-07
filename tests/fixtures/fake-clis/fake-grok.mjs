#!/usr/bin/env node
// Minimal fake of `grok -p --output-format streaming-json`.
// Emits the grok 1.0.77 streaming-json shapes the driver maps, including
// `kind: "write"` (not a valid ACP tool kind) and an `end` line with sessionId.
import { existsSync, writeFileSync } from "node:fs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf("-p");
const prompt = promptIndex >= 0 ? (argv[promptIndex + 1] ?? "") : "";
const resumeIndex = argv.indexOf("--resume");
const isResume = resumeIndex >= 0;

if (process.env.FAKE_GROK_ARGS_FILE) {
  writeFileSync(process.env.FAKE_GROK_ARGS_FILE, JSON.stringify(argv));
}
if (process.env.FAKE_GROK_ENV_FILE) {
  const keys = [
    "GROK_CLAUDE_AGENTS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED",
    "GROK_CLAUDE_MCPS_ENABLED",
    "GROK_CLAUDE_RULES_ENABLED",
    "GROK_CLAUDE_SKILLS_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED",
    "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CURSOR_MCPS_ENABLED",
    "GROK_CURSOR_RULES_ENABLED",
    "GROK_CURSOR_SKILLS_ENABLED",
    "GROK_MANAGED_MCPS_ENABLED",
    "GROK_WORKFLOWS",
    "ELECTRON_RUN_AS_NODE",
  ];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  writeFileSync(process.env.FAKE_GROK_ENV_FILE, JSON.stringify(env));
}

if (prompt.includes("PROVIDER_AUTH_ERROR")) {
  emit({
    type: "error",
    message: "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
  });
  process.exit(1);
}

if (prompt.includes("STDERR_AUTH")) {
  process.stderr.write("Error: Not signed in. Run `grok login`.\n");
  process.exit(1);
}

if (prompt.includes("EXIT_NONZERO")) {
  process.stderr.write("private detail\n");
  process.exit(42);
}

if (prompt.includes("SLOW_CANCEL")) {
  const [, releaseFile = null, terminatedFile = null] = prompt.match(/SLOW_CANCEL:(\S+):(\S+)/) ?? [];
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
    if (terminatedFile) writeFileSync(terminatedFile, "");
  });
  emit({ type: "text", data: "ready" });
  setInterval(() => {
    if (terminating && (!releaseFile || existsSync(releaseFile))) process.exit(0);
  }, 5);
  await new Promise(() => {});
}

if (prompt.includes("SLOW_FORCE_KILL")) {
  process.on("SIGTERM", () => {});
  emit({ type: "text", data: "ready" });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

emit({ type: "available_commands", tools: [], commands: [] });
emit({ type: "usage", usage: { input_tokens: 1, output_tokens: 1 }, signature: "do-not-forward" });

if (prompt.includes("RUN_TOOL")) {
  emit({
    type: "tool_call",
    toolCallId: "call-1",
    title: "write",
    kind: "write",
    status: "pending",
    toolName: "write",
    rawInput: { file_path: "hello.txt", content: "hi" },
    content: [],
    locations: [],
  });
  emit({
    type: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    rawOutput: { ok: true },
    content: [{ type: "diff", path: "hello.txt", oldText: "", newText: "hi", _meta: { details: [{ secret: true }] } }],
  });
}

const reply = isResume ? `resumed:${prompt}` : `echo:${prompt}`;
emit({ type: "text", data: reply });
emit({ type: "end", stopReason: "end_turn", sessionId: "11111111-1111-4111-8111-111111111111" });
process.exit(0);
