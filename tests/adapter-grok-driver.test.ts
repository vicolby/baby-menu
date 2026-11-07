import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { GrokDriver } from "../src/adapters/grok/driver";
import type * as schema from "@agentclientprotocol/sdk";

const FAKE = join(__dirname, "fixtures", "fake-clis", "fake-grok.mjs");

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
  });
}

async function slowCancelGate(): Promise<{ prompt: string; terminated: Promise<void>; release: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "grok-driver-"));
  const sentinel = join(dir, "release-exit");
  const terminated = join(dir, "observed-sigterm");
  return { prompt: `SLOW_CANCEL:${sentinel}:${terminated}`, terminated: waitForFile(terminated), release: () => writeFile(sentinel, "") };
}

describe("GrokDriver (against a fake grok CLI)", () => {
  let driver: GrokDriver | null = null;
  const envKeys = ["FAKE_GROK_ARGS_FILE", "FAKE_GROK_ENV_FILE"] as const;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
    for (const key of envKeys) delete process.env[key];
  });

  function makeDriver(): GrokDriver {
    driver = new GrokDriver({ command: FAKE });
    return driver;
  }

  it("streams a text chunk and resolves end_turn", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    const stop = await d.prompt("hello", (u) => updates.push(u), new AbortController().signal);
    expect(stop).toBe("end_turn");
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "echo:hello" },
    });
    expect(updates.some((u) => JSON.stringify(u).includes("do-not-forward"))).toBe(false);
  });

  it("resumes the captured session and keeps the headless isolation flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-args-"));
    const argsFile = join(dir, "args.json");
    const envFile = join(dir, "env.json");
    process.env.FAKE_GROK_ARGS_FILE = argsFile;
    process.env.FAKE_GROK_ENV_FILE = envFile;
    const d = makeDriver();
    await d.start(tmpdir());
    const signal = new AbortController().signal;
    await d.prompt("first", () => {}, signal);
    const firstArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(firstArgs).toEqual([
      "--no-leader",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--verbatim",
      "--no-plan",
      "--no-subagents",
      "--no-memory",
      "-p",
      "first",
    ]);
    expect(firstArgs).not.toContain("--worktree");

    const updates: schema.SessionUpdate[] = [];
    await d.prompt("second", (u) => updates.push(u), signal);
    const resumeArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(resumeArgs).toContain("--resume");
    expect(resumeArgs[resumeArgs.indexOf("--resume") + 1]).toBe("11111111-1111-4111-8111-111111111111");
    expect(resumeArgs.at(-2)).toBe("-p");
    expect(resumeArgs.at(-1)).toBe("second");
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "resumed:second" },
    });

    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string | null>;
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBe("0");
    expect(env.GROK_CURSOR_SKILLS_ENABLED).toBe("0");
    expect(env.GROK_MANAGED_MCPS_ENABLED).toBe("0");
    expect(env.GROK_WORKFLOWS).toBe("0");
    expect(env.ELECTRON_RUN_AS_NODE).toBeNull();
  });

  it("maps a write tool call through to ACP", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("please RUN_TOOL now", (u) => updates.push(u), new AbortController().signal);
    expect(updates.find((u) => u.sessionUpdate === "tool_call")).toMatchObject({ kind: "edit", status: "pending" });
    expect(updates.find((u) => u.sessionUpdate === "tool_call_update")).toMatchObject({
      status: "completed",
      content: [{ type: "diff", path: "hello.txt", newText: "hi" }],
    });
  });

  it("rejects a terminal authentication failure without the raw provider text", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const prompt = d.prompt("PROVIDER_AUTH_ERROR", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "AUTHENTICATION_FAILED",
      message: "Grok is not authenticated. Run `grok login` and try again.",
    });
    await expect(prompt).rejects.not.toThrow(/device-code/);
  });

  it("classifies a stderr-only sign-in failure", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    await expect(d.prompt("STDERR_AUTH", () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Grok is not authenticated. Run `grok login` and try again.",
    });
  });

  it("rejects a nonzero CLI exit without forwarding stderr", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const prompt = d.prompt("EXIT_NONZERO", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({
      code: "CLI_EXIT_FAILED",
      message: "Grok CLI exited with code 42.",
    });
    await expect(prompt).rejects.not.toThrow(/private detail/);
  });

  it("resolves cancelled when the signal aborts before spawning", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const ac = new AbortController();
    ac.abort();
    expect(await d.prompt("hi", () => {}, ac.signal)).toBe("cancelled");
  });

  it("waits for the child process to exit before resolving cancellation", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    const ac = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      gate.prompt,
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      ac.signal,
    );
    await readyPromise;
    let released = false;
    let settled = false;
    const settlement = prompt.then((result) => {
      settled = true;
      return { result, released };
    });
    ac.abort();
    await gate.terminated;
    await Promise.resolve();
    expect(settled).toBe(false);

    released = true;
    await gate.release();
    expect(await settlement).toEqual({ result: "cancelled", released: true });
  });

  it("force-kills a child that outlives the termination grace period", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      "SLOW_FORCE_KILL",
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      new AbortController().signal,
    );
    await readyPromise;
    await d.dispose();
    expect(await prompt).toBe("cancelled");
  });
});
