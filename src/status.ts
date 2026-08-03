import type { BridgeState, DisplayState, FreshnessState, HooksStatus, ProjectState } from "./domain.js";

export function freshnessFor(
  observedAt: number | undefined,
  freshMinutes: number,
  staleMinutes: number,
  now = Date.now()
): FreshnessState {
  if (!observedAt || !Number.isFinite(observedAt)) return "stale";
  const ageMinutes = (now - observedAt) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes >= staleMinutes) return "stale";
  if (ageMinutes >= freshMinutes) return "aging";
  return "fresh";
}

export function formatAge(observedAt: number | undefined, now = Date.now()): string {
  if (!observedAt || !Number.isFinite(observedAt)) return "";
  const milliseconds = Math.max(0, now - observedAt);
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const state = (
  label: string,
  glyph: string,
  color: string,
  background: string,
  urgent = false,
  stale = false,
  solid = false
): DisplayState => ({ label, glyph, color, background, urgent, stale, solid });

export function deriveDisplayState(
  project: ProjectState | undefined,
  bridge: BridgeState,
  hooks: HooksStatus,
  freshMinutes: number,
  staleMinutes: number,
  now = Date.now()
): DisplayState {
  if (hooks === "missing" || hooks === "partial" || hooks === "unreadable") {
    return state("SETUP", "⚙", "#FBBF24", "#33270B", true);
  }
  if (bridge === "error") return state("BRIDGE", "!", "#FBBF24", "#33270B", true);
  if (!project) return state(bridge === "starting" ? "STARTING" : "NO SESSION", "·", "#9CA3AF", "#17191D");

  const stale = freshnessFor(project.recencyAt, freshMinutes, staleMinutes, now) === "stale";
  switch (project.phase) {
    case "needs_approval":
      return state("APPROVAL", "!", "#2A1902", "#F59E0B", true, stale, true);
    case "needs_input":
      return state("INPUT", "?", "#2A2302", "#FDE047", true, stale, true);
    case "failed":
      return state("FAILED", "×", "#FFF1F2", "#DC2626", true, stale, true);
    case "working":
      return project.stale
        ? state("ACTIVE?", "▶", "#7BA3CF", "#111D2C", false, true)
        : state("WORKING", "▶", "#93C5FD", "#102A43", false, stale);
    case "done":
      return state("DONE", "✓", "#052E16", "#22C55E", false, stale, true);
    case "idle":
      return state("IDLE", "·", "#D1D5DB", "#24272D", false, stale);
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}
