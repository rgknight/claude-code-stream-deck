import { describe, expect, it } from "vitest";

import type { ClaudeSession } from "../src/domain.js";
import type { NotifyEvent } from "../src/notify-bridge.js";
import { acknowledgeSessions, applySessionEvent, gcSessions } from "../src/session-model.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function event(overrides: Partial<NotifyEvent> & { type: NotifyEvent["type"] }): NotifyEvent {
  return {
    version: 2,
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/repo",
    observedAt: new Date(NOW).toISOString(),
    ...overrides
  };
}

describe("session state machine", () => {
  it("upserts unknown sessions from any event so restarts recover", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const result = applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    expect(result).toEqual({ changed: true, persist: true });
    expect(sessions["11111111-2222-3333-4444-555555555555"]?.phase).toBe("working");
  });

  it("walks the prompt → notification → post-tool → stop lifecycle", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "session-start", source: "startup" }), NOW);
    expect(sessions[id]?.phase).toBe("idle");
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "notification", notificationType: "permission_prompt", message: "Approve Bash?" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_approval");
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "stop" }), NOW);
    expect(sessions[id]?.phase).toBe("done");
    applySessionEvent(sessions, event({ type: "session-end", reason: "clear" }), NOW);
    expect(sessions[id]).toBeUndefined();
  });

  it("classifies notification types exactly and degrades unknown types to input", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "notification", notificationType: "permission_prompt" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_approval");
    applySessionEvent(sessions, event({ type: "notification", notificationType: "idle_prompt" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "notification", notificationType: "auth_success" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "notification", notificationType: "brand_new_type" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "notification" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
  });

  it("parks the session on question tools that fire no notification", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    const parked = applySessionEvent(sessions, event({ type: "pre-tool", toolName: "AskUserQuestion" }), NOW);
    expect(parked).toEqual({ changed: true, persist: true });
    expect(sessions[id]?.phase).toBe("needs_input");
    expect(sessions[id]?.notificationType).toBe("question_prompt");
    // Answering the question runs the tool, which reports back as post-tool.
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    expect(sessions[id]?.notificationType).toBeUndefined();

    applySessionEvent(sessions, event({ type: "pre-tool", toolName: "ExitPlanMode" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
  });

  it("flags approval from the permission-request hook when no notification fires", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    // Editor-hosted sessions delegate the prompt over stdio, so the TUI's
    // `permission_prompt` notification never arrives.
    const parked = applySessionEvent(sessions, event({ type: "permission-request", toolName: "Bash" }), NOW);
    expect(parked).toEqual({ changed: true, persist: true });
    expect(sessions[id]?.phase).toBe("needs_approval");
    expect(sessions[id]?.notificationType).toBe("permission_prompt");
    // Approving runs the tool, which reports back as post-tool.
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    expect(sessions[id]?.notificationType).toBeUndefined();
  });

  it("reads a permission request for a question tool as input, not approval", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "permission-request", toolName: "AskUserQuestion" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
    expect(sessions[id]?.notificationType).toBe("question_prompt");
  });

  it("treats any other pre-tool event as proof of work in flight", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "notification", notificationType: "idle_prompt" }), NOW);
    expect(sessions[id]?.phase).toBe("needs_input");
    applySessionEvent(sessions, event({ type: "pre-tool", toolName: "Bash" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "pre-tool" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
  });

  it("does not knock a working session back to idle on compact or resume", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "session-start", source: "compact" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "session-start", source: "clear" }), NOW);
    expect(sessions[id]?.phase).toBe("idle");
  });

  it("keeps working state through post-tool but marks failures", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "stop-failure", reason: "rate_limit" }), NOW);
    expect(sessions[id]?.phase).toBe("failed");
  });

  it("expires crashed sessions and flags stalled work in GC", () => {
    const sessions: Record<string, ClaudeSession> = {};
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    const options = { staleWorkingMinutes: 120, sessionTtlHours: 24, backgroundSettleSeconds: 90 };

    const fresh = gcSessions(sessions, options, NOW + 60 * 60_000);
    expect(fresh.changed).toBe(false);

    const stalled = gcSessions(sessions, options, NOW + 3 * 3_600_000);
    expect(stalled).toEqual({ changed: true, persist: false });
    expect(sessions["11111111-2222-3333-4444-555555555555"]?.stale).toBe(true);

    const expired = gcSessions(sessions, options, NOW + 25 * 3_600_000);
    expect(expired).toEqual({ changed: true, persist: true });
    expect(Object.keys(sessions)).toHaveLength(0);
  });

  it("reopens a stopped session as soon as a tool runs again", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "stop" }), NOW);
    expect(sessions[id]?.phase).toBe("done");
    // The turn ended, but a tool call proves the session is running again.
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW + 1_000);
    expect(sessions[id]?.phase).toBe("working");
    applySessionEvent(sessions, event({ type: "stop" }), NOW + 2_000);
    expect(sessions[id]?.phase).toBe("done");
    applySessionEvent(sessions, event({ type: "pre-tool", toolName: "Bash" }), NOW + 3_000);
    expect(sessions[id]?.phase).toBe("working");
  });

  it("holds a session that launched background agents open until it falls silent", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    const options = { staleWorkingMinutes: 120, sessionTtlHours: 24, backgroundSettleSeconds: 90 };
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "post-tool", background: true }), NOW);
    // The main loop stops at every turn boundary while the agents work on.
    applySessionEvent(sessions, event({ type: "stop", observedAt: new Date(NOW + 1_000).toISOString() }), NOW + 1_000);
    expect(sessions[id]?.phase).toBe("working");
    expect(gcSessions(sessions, options, NOW + 60_000).changed).toBe(false);
    expect(sessions[id]?.phase).toBe("working");

    // An agent reports a tool call, which pushes the settle window out again.
    applySessionEvent(
      sessions,
      event({ type: "post-tool", observedAt: new Date(NOW + 80_000).toISOString() }),
      NOW + 80_000
    );
    expect(gcSessions(sessions, options, NOW + 120_000).changed).toBe(false);
    expect(sessions[id]?.phase).toBe("working");

    const settled = gcSessions(sessions, options, NOW + 200_000);
    expect(settled).toEqual({ changed: true, persist: true });
    expect(sessions[id]?.phase).toBe("done");
    expect(sessions[id]?.stoppedAt).toBeUndefined();
    expect(sessions[id]?.backgroundAt).toBeUndefined();
  });

  it("settles a background session only from working, never over a pending prompt", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    const options = { staleWorkingMinutes: 120, sessionTtlHours: 24, backgroundSettleSeconds: 90 };
    applySessionEvent(sessions, event({ type: "post-tool", background: true }), NOW);
    applySessionEvent(sessions, event({ type: "stop" }), NOW);
    // A background agent can still ask for permission after the turn ended.
    applySessionEvent(sessions, event({ type: "permission-request", toolName: "Bash" }), NOW + 1_000);
    expect(sessions[id]?.phase).toBe("needs_approval");
    expect(gcSessions(sessions, options, NOW + 200_000).changed).toBe(false);
    expect(sessions[id]?.phase).toBe("needs_approval");
  });

  it("marks a session done at once when no background agent is in flight", () => {
    const sessions: Record<string, ClaudeSession> = {};
    const id = "11111111-2222-3333-4444-555555555555";
    applySessionEvent(sessions, event({ type: "prompt-submit" }), NOW);
    applySessionEvent(sessions, event({ type: "post-tool" }), NOW);
    applySessionEvent(sessions, event({ type: "stop" }), NOW);
    expect(sessions[id]?.phase).toBe("done");
    expect(sessions[id]?.stoppedAt).toBeUndefined();
  });

  it("acknowledges only finished sessions", () => {
    const sessions: Record<string, ClaudeSession> = {};
    applySessionEvent(sessions, event({ type: "stop" }), NOW);
    applySessionEvent(
      sessions,
      event({ type: "prompt-submit", sessionId: "99999999-2222-3333-4444-555555555555" }),
      NOW
    );
    const all = Object.values(sessions);
    expect(acknowledgeSessions(all)).toBe(true);
    expect(sessions["11111111-2222-3333-4444-555555555555"]?.phase).toBe("idle");
    expect(sessions["99999999-2222-3333-4444-555555555555"]?.phase).toBe("working");
  });
});
