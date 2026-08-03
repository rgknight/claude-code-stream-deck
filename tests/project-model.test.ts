import { describe, expect, it } from "vitest";

import type { ClaudeSession, ProjectState, SessionPhase } from "../src/domain.js";
import { choosePrimarySession, compareProjects, isUnderway, reconcileSlots } from "../src/project-model.js";
import { DEFAULT_GLOBAL_SETTINGS } from "../src/settings.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function session(id: string, phase: SessionPhase, updatedAt = NOW): ClaudeSession {
  return { sessionId: id, cwd: "/repo", phase, startedAt: updatedAt, updatedAt };
}

function project(id: string, phase: SessionPhase, recencyAt = NOW): ProjectState {
  return {
    projectId: id,
    projectRoot: `/repo/${id}`,
    identityAnchor: `/repo/${id}`,
    displayName: id,
    sessions: [session(`${id}-session`, phase, recencyAt)],
    primarySessionId: `${id}-session`,
    phase,
    stale: false,
    attentionCount: phase === "needs_input" || phase === "needs_approval" ? 1 : 0,
    recencyAt
  };
}

describe("primary session selection", () => {
  it("prefers approval waits over newer working sessions", () => {
    const waiting = session("waiting", "needs_approval", NOW - 60_000);
    const newer = session("newer", "working", NOW);
    expect(choosePrimarySession([newer, waiting]).sessionId).toBe("waiting");
  });

  it("breaks phase ties by recency", () => {
    const older = session("older", "working", NOW - 60_000);
    const newer = session("newer", "working", NOW);
    expect(choosePrimarySession([older, newer]).sessionId).toBe("newer");
  });
});

describe("project ordering and lifecycle", () => {
  it("orders projects by urgency then recency", () => {
    const projects = [project("idle", "idle"), project("input", "needs_input"), project("working", "working")];
    projects.sort(compareProjects);
    expect(projects.map((item) => item.projectId)).toEqual(["input", "working", "idle"]);
  });

  it("keeps attention and working projects underway but expires finished ones", () => {
    expect(isUnderway(project("a", "needs_input", NOW - 90 * 86_400_000), DEFAULT_GLOBAL_SETTINGS, NOW)).toBe(true);
    expect(isUnderway(project("b", "done", NOW - 60 * 60_000), DEFAULT_GLOBAL_SETTINGS, NOW)).toBe(true);
    expect(isUnderway(project("c", "done", NOW - 48 * 3_600_000), DEFAULT_GLOBAL_SETTINGS, NOW)).toBe(false);
    expect(isUnderway(project("d", "idle", NOW - 30 * 86_400_000), DEFAULT_GLOBAL_SETTINGS, NOW)).toBe(false);
  });
});

describe("sticky slot reconciliation", () => {
  it("keeps a project on its slot when priorities change", () => {
    const slots: Record<string, string> = {};
    const working = project("alpha", "working");
    const other = project("beta", "working", NOW - 1_000);
    reconcileSlots(slots, [working, other], 4);
    expect(slots["0"]).toBe("alpha");
    expect(slots["1"]).toBe("beta");

    // beta now needs input; it must stay on slot 1, not jump to slot 0.
    const betaNeedsInput = { ...other, phase: "needs_input" as const, attentionCount: 1 };
    const changed = reconcileSlots(slots, [betaNeedsInput, working], 4);
    expect(changed).toBe(false);
    expect(slots["0"]).toBe("alpha");
    expect(slots["1"]).toBe("beta");
  });

  it("frees slots when projects end and reassigns to the lowest free slot", () => {
    const slots: Record<string, string> = { "0": "alpha", "1": "beta", "2": "gamma" };
    const beta = project("beta", "working");
    const gamma = project("gamma", "working");
    reconcileSlots(slots, [beta, gamma], 4);
    expect(slots["0"]).toBeUndefined();
    const fresh = project("delta", "working");
    reconcileSlots(slots, [beta, gamma, fresh], 4);
    expect(slots["0"]).toBe("delta");
  });

  it("evicts an idle project only for attention-needing overflow", () => {
    const slots: Record<string, string> = {};
    const assigned = [
      project("a", "working"),
      project("b", "working"),
      project("c", "idle", NOW - 60_000),
      project("d", "working")
    ];
    reconcileSlots(slots, assigned, 4);

    // A fifth working project does not evict anyone.
    const workingOverflow = project("e", "working");
    reconcileSlots(slots, [...assigned, workingOverflow], 4);
    expect(Object.values(slots)).not.toContain("e");

    // A fifth attention-needing project evicts the idle one.
    const urgentOverflow = project("f", "needs_approval");
    reconcileSlots(slots, [...assigned, urgentOverflow], 4);
    expect(Object.values(slots)).toContain("f");
    expect(Object.values(slots)).not.toContain("c");
  });

  it("never evicts working or attention-needing projects", () => {
    const slots: Record<string, string> = {};
    const assigned = [
      project("a", "working"),
      project("b", "needs_input"),
      project("c", "working"),
      project("d", "needs_approval")
    ];
    reconcileSlots(slots, assigned, 4);
    const urgentOverflow = project("e", "needs_approval");
    reconcileSlots(slots, [...assigned, urgentOverflow], 4);
    expect(Object.values(slots)).not.toContain("e");
    expect(Object.values(slots)).toHaveLength(4);
  });

  it("drops slot entries above the configured slot count", () => {
    const slots: Record<string, string> = { "7": "alpha" };
    const alpha = project("alpha", "working");
    reconcileSlots(slots, [alpha], 4);
    expect(slots["7"]).toBeUndefined();
    expect(slots["0"]).toBe("alpha");
  });
});
