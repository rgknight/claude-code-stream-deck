import { describe, expect, it } from "vitest";

import type { ProjectState, SessionPhase } from "../src/domain.js";
import { deriveDisplayState, formatAge, freshnessFor } from "../src/status.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function project(phase: SessionPhase, overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "sha256:abc",
    projectRoot: "/repo",
    identityAnchor: "/repo",
    displayName: "repo",
    sessions: [],
    primarySessionId: "session-1",
    phase,
    stale: false,
    attentionCount: 0,
    recencyAt: NOW - 5 * 60_000,
    ...overrides
  };
}

describe("display precedence", () => {
  it("puts setup problems above everything else", () => {
    expect(deriveDisplayState(project("needs_approval"), "running", "missing", 15, 120, NOW).label).toBe("SETUP");
    expect(deriveDisplayState(project("needs_approval"), "error", "installed", 15, 120, NOW).label).toBe("BRIDGE");
  });

  it("maps session phases to labels", () => {
    expect(deriveDisplayState(project("needs_approval"), "running", "installed", 15, 120, NOW).label).toBe("APPROVAL");
    expect(deriveDisplayState(project("needs_input"), "running", "installed", 15, 120, NOW).label).toBe("INPUT");
    expect(deriveDisplayState(project("failed"), "running", "installed", 15, 120, NOW).label).toBe("FAILED");
    expect(deriveDisplayState(project("working"), "running", "installed", 15, 120, NOW).label).toBe("WORKING");
    expect(deriveDisplayState(project("done"), "running", "installed", 15, 120, NOW).label).toBe("DONE");
    expect(deriveDisplayState(project("idle"), "running", "installed", 15, 120, NOW).label).toBe("IDLE");
  });

  it("marks stalled work as unverified activity", () => {
    expect(deriveDisplayState(project("working", { stale: true }), "running", "installed", 15, 120, NOW).label).toBe("ACTIVE?");
  });

  it("shows empty and starting states without a project", () => {
    expect(deriveDisplayState(undefined, "starting", "installed", 15, 120, NOW).label).toBe("STARTING");
    expect(deriveDisplayState(undefined, "running", "installed", 15, 120, NOW).label).toBe("NO SESSION");
  });

  it("flags urgent states for attention", () => {
    expect(deriveDisplayState(project("needs_approval"), "running", "installed", 15, 120, NOW).urgent).toBe(true);
    expect(deriveDisplayState(project("working"), "running", "installed", 15, 120, NOW).urgent).toBe(false);
  });

  it("does not demand setup while hook status is still unknown", () => {
    expect(deriveDisplayState(project("working"), "running", "unknown", 15, 120, NOW).label).toBe("WORKING");
  });
});

describe("freshness", () => {
  it("classifies ages against the configured thresholds", () => {
    expect(freshnessFor(NOW - 60_000, 15, 120, NOW)).toBe("fresh");
    expect(freshnessFor(NOW - 30 * 60_000, 15, 120, NOW)).toBe("aging");
    expect(freshnessFor(NOW - 180 * 60_000, 15, 120, NOW)).toBe("stale");
    expect(freshnessFor(undefined, 15, 120, NOW)).toBe("stale");
  });

  it("formats ages compactly", () => {
    expect(formatAge(NOW - 30_000, NOW)).toBe("now");
    expect(formatAge(NOW - 20 * 60_000, NOW)).toBe("20m");
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(formatAge(NOW - 3 * 86_400_000, NOW)).toBe("3d");
    expect(formatAge(undefined, NOW)).toBe("");
  });
});
