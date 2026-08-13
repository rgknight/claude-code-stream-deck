import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = path.resolve("com.claudecode.monitor.sdPlugin/helpers/claude_streamdeck_notify.py");

let dataDir: string;
/** stdout of the most recent `runHelper` call; decision-capable hooks read it. */
let lastStdout = "";

async function runHelper(payload: unknown): Promise<number> {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  lastStdout = "";
  return new Promise<number>((resolve, reject) => {
    const child = spawn("python3", [HELPER], {
      env: { ...process.env, CLAUDE_STREAMDECK_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "ignore"]
    });
    child.stdout.on("data", (chunk: Buffer) => {
      lastStdout += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Helper timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.stdin.end(input);
  });
}

async function spooledEvents(): Promise<Array<Record<string, unknown>>> {
  const spool = path.join(dataDir, "spool");
  let names: string[];
  try {
    names = await readdir(spool);
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const name of names.sort()) {
    events.push(JSON.parse(await readFile(path.join(spool, name), "utf8")) as Record<string, unknown>);
  }
  return events;
}

describe("claude hook helper (end-to-end, no bridge running)", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "claude-streamdeck-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("spools a minimized notification event when the bridge is down", async () => {
    await runHelper({
      hook_event_name: "Notification",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/private/transcript.jsonl",
      cwd: "/repo/project",
      permission_mode: "default",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash"
    });
    const events = await spooledEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 2,
      type: "notification",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/repo/project",
      notificationType: "permission_prompt",
      message: "Claude needs your permission to use Bash"
    });
    // Privacy: transcript path and prompt text must not leave the hook payload.
    expect(events[0]).not.toHaveProperty("transcript_path");
    expect(events[0]).not.toHaveProperty("permission_mode");
  });

  it("never spools high-volume post-tool events", async () => {
    await runHelper({
      hook_event_name: "PostToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      cwd: "/repo/project",
      tool_name: "Bash"
    });
    expect(await spooledEvents()).toHaveLength(0);
  });

  it("carries the tool name on pre-tool events so question prompts are visible", async () => {
    await runHelper({
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      cwd: "/repo/project",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which database?" }] }
    });
    const events = await spooledEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 2, type: "pre-tool", toolName: "AskUserQuestion" });
    // Privacy: the question text itself must never leave the hook payload.
    expect(events[0]).not.toHaveProperty("tool_input");
    expect(JSON.stringify(events[0])).not.toContain("database");
  });

  it("carries the tool name but no input on permission-request events", async () => {
    const code = await runHelper({
      hook_event_name: "PermissionRequest",
      session_id: "11111111-2222-3333-4444-555555555555",
      cwd: "/repo/project",
      tool_name: "Bash",
      tool_use_id: "toolu_01",
      tool_input: { command: "rm -rf /secret-vault" }
    });
    // PermissionRequest is a decision-capable hook: silence plus exit 0 must
    // leave the prompt for the user.
    expect(code).toBe(0);
    expect(lastStdout).toBe("");
    const events = await spooledEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 2, type: "permission-request", toolName: "Bash" });
    expect(events[0]).not.toHaveProperty("tool_input");
    expect(JSON.stringify(events[0])).not.toContain("secret-vault");
  });

  it("exits 0 and stays silent on unknown events and malformed input", async () => {
    expect(await runHelper({ hook_event_name: "SomethingNew", session_id: "abc", cwd: "/repo" })).toBe(0);
    expect(await runHelper("this is not json")).toBe(0);
    expect(await runHelper({ hook_event_name: "Stop", session_id: "bad id with spaces" })).toBe(0);
    expect(await spooledEvents()).toHaveLength(0);
  });

  it("flags a background agent launch on post-tool without carrying the response", async () => {
    // post-tool is never spooled, so this one has to go over the bridge.
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    await writeFile(
      path.join(dataDir, "notify-endpoint.json"),
      JSON.stringify({ version: 1, host: "127.0.0.1", port, token: "t".repeat(43) })
    );
    try {
      await runHelper({
        hook_event_name: "PostToolUse",
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd: "/repo/project",
        tool_name: "Agent",
        tool_input: { prompt: "audit the vault" },
        tool_response: { isAsync: true, status: "async_launched", agentId: "a1", prompt: "audit the vault" }
      });
      await runHelper({
        hook_event_name: "PostToolUse",
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd: "/repo/project",
        tool_name: "Agent",
        tool_response: { isAsync: false, content: "the vault holds 3 secrets" }
      });
      await runHelper({
        hook_event_name: "PostToolUse",
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd: "/repo/project",
        tool_name: "Bash",
        tool_response: { stdout: "ok" }
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({ type: "post-tool", background: true });
    // A foreground agent has finished by the time post-tool fires, and other
    // tools never carry the flag at all.
    expect(received[1]).not.toHaveProperty("background");
    expect(received[2]).not.toHaveProperty("background");
    // Privacy: only the flag is mined out of the response.
    expect(JSON.stringify(received)).not.toContain("vault");
  });

  it("maps stop and session lifecycle events", async () => {
    await runHelper({ hook_event_name: "Stop", session_id: "s-1", cwd: "/repo" });
    await runHelper({ hook_event_name: "SessionEnd", session_id: "s-1", cwd: "/repo", reason: "clear" });
    const events = await spooledEvents();
    expect(events.map((event) => event.type).sort()).toEqual(["session-end", "stop"]);
    const end = events.find((event) => event.type === "session-end");
    expect(end?.reason).toBe("clear");
  });
});
