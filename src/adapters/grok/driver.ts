import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type * as schema from "@agentclientprotocol/sdk";
import { AdapterTurnError, providerTurnError, type SessionDriver, type UpdateSink } from "../shared/types.js";
import { LineReader } from "../shared/line-reader.js";
import { logDebug } from "../shared/log.js";
import { childEnv } from "../shared/child-env.js";
import { mapGrokEvent, type GrokStreamEvent } from "./mapper.js";

const SCOPE = "grok-adapter";
const TERMINATION_GRACE_MS = 1000;
const STDERR_CLASSIFY_LIMIT = 4_096;

/**
 * Process-local isolation. Grok has no `--ignore-user-config`: auth, personal
 * MCP, skills, plugins, and permission rules still come from `~/.grok`.
 * These env vars only turn off the cross-harness scans and background work
 * that would otherwise run inside a Baby Menu turn. `0` is accepted (grok
 * 1.0.77 reports the cell source as `env`).
 */
const GROK_ISOLATION_ENV: Record<string, string> = {
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_RULES_ENABLED: "0",
  GROK_CLAUDE_SKILLS_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_MANAGED_MCPS_ENABLED: "0",
  GROK_WORKFLOWS: "0",
};

export type GrokDriverOptions = {
  /** Override the grok binary (tests inject a fake). Defaults to "grok". */
  command?: string;
};

/**
 * Drives `grok -p --output-format streaming-json` per turn. The first turn
 * starts a session and captures `end.sessionId`; later turns pass `--resume`
 * so conversation memory carries over.
 *
 * Per-turn, like the other adapters: streaming-json is read-only, so a
 * permission prompt would hang. `--permission-mode bypassPermissions` is the
 * approve-all equivalent. `--no-leader` keeps the turn off the user's shared
 * Grok leader. `--no-plan` and `--no-subagents` keep edits in the change-session
 * working directory instead of a plan file or a subagent worktree.
 */
export class GrokDriver implements SessionDriver {
  private readonly command: string;
  private cwd: string | null = null;
  private sessionId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private activePrompt: Promise<schema.StopReason> | null = null;
  private activeCancel: (() => void) | null = null;

  constructor(options: GrokDriverOptions = {}) {
    this.command = options.command ?? "grok";
  }

  async start(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  async prompt(text: string, sink: UpdateSink, signal: AbortSignal): Promise<schema.StopReason> {
    const cwd = this.cwd;
    if (!cwd) throw new Error("grok session not started");
    if (this.child) throw new Error("a prompt is already in progress");

    const args = [
      "--no-leader",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--verbatim",
      "--no-plan",
      "--no-subagents",
      "--no-memory",
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
      "-p",
      text,
    ];

    logDebug(SCOPE, "spawn", this.command, this.sessionId ? "(resume)" : "(new)");
    const child = spawn(this.command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...childEnv(), ...GROK_ISOLATION_ENV },
    });
    this.child = child;
    // The prompt is an argument. Close stdin so a headless grok that waits for
    // EOF cannot hang the turn.
    child.stdin.end();
    const reader = new LineReader();

    const activePrompt = new Promise<schema.StopReason>((resolve, reject) => {
      let settled = false;
      let stopReason: schema.StopReason | null = null;
      let terminalError: AdapterTurnError | null = null;
      let cancelled = false;
      let stderrText = "";
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (reason: schema.StopReason) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.child = null;
        this.activePrompt = null;
        this.activeCancel = null;
        signal.removeEventListener("abort", onAbort);
        resolve(reason);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.child = null;
        this.activePrompt = null;
        this.activeCancel = null;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      };

      const onAbort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        logDebug(SCOPE, "cancel: killing grok");
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      };
      this.activeCancel = onAbort;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of reader.push(chunk)) {
          let event: GrokStreamEvent;
          try {
            event = JSON.parse(line) as GrokStreamEvent;
          } catch {
            logDebug(SCOPE, "non-json stdout line", line);
            continue;
          }
          if (event.type === "end" && event.sessionId) this.sessionId = event.sessionId;
          const result = mapGrokEvent(event);
          for (const update of result.updates) sink(update);
          if (result.terminalError) terminalError = result.terminalError;
          if (result.stopReason) {
            stopReason = result.stopReason;
            if (result.stopReason === "end_turn") terminalError = null;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderrText.length < STDERR_CLASSIFY_LIMIT) {
          stderrText = (stderrText + chunk).slice(0, STDERR_CLASSIFY_LIMIT);
        }
        logDebug(SCOPE, "stderr", chunk.trimEnd());
      });
      child.on("error", () => {
        if (cancelled) settle("cancelled");
        else fail(new AdapterTurnError("CLI_START_FAILED", "Grok CLI could not be started."));
      });
      child.on("exit", (code) => {
        logDebug(SCOPE, "grok exited", code);
        if (cancelled) {
          settle("cancelled");
          return;
        }
        if (terminalError) {
          fail(terminalError);
          return;
        }
        if (code !== 0) {
          const classified = providerTurnError("Grok", stderrText);
          if (classified.code === "AUTHENTICATION_FAILED" || classified.code === "RATE_LIMITED") {
            fail(classified);
            return;
          }
          fail(new AdapterTurnError("CLI_EXIT_FAILED", `Grok CLI exited with code ${code ?? "unknown"}.`));
          return;
        }
        settle(stopReason ?? "end_turn");
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    this.activePrompt = activePrompt;
    return activePrompt;
  }

  async dispose(): Promise<void> {
    const activePrompt = this.activePrompt;
    const activeCancel = this.activeCancel;
    if (activePrompt && activeCancel) {
      activeCancel();
      await activePrompt.catch(() => undefined);
      return;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
    }
  }
}
