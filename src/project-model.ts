import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ClaudeSession, ProjectState, SessionPhase } from "./domain.js";
import type { GlobalSettings } from "./settings.js";

const execFileAsync = promisify(execFile);

const ATTENTION_PHASES = new Set<SessionPhase>(["needs_input", "needs_approval"]);

export interface CanonicalProject {
  projectId: string;
  projectRoot: string;
  identityAnchor: string;
}

function identityPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function canonicalizeProject(cwd: string, groupWorktrees: boolean): Promise<CanonicalProject> {
  if (!cwd || cwd.includes("\0")) throw new Error("Invalid working directory");
  if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is unavailable");
  const resolvedCwd = await realpath(cwd);
  const topLevelRaw = await gitOutput(resolvedCwd, ["rev-parse", "--show-toplevel"]);
  const projectRoot = topLevelRaw ? await realpath(topLevelRaw) : resolvedCwd;
  let identityAnchor = projectRoot;
  if (topLevelRaw && groupWorktrees) {
    const commonRaw = await gitOutput(resolvedCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (commonRaw) identityAnchor = path.resolve(projectRoot, commonRaw);
  }
  const identity = identityPath(identityAnchor);
  return {
    projectId: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
    projectRoot,
    identityAnchor
  };
}

export function sessionNeedsAttention(session: ClaudeSession): boolean {
  return ATTENTION_PHASES.has(session.phase);
}

function phaseScore(phase: SessionPhase): number {
  switch (phase) {
    case "needs_approval":
      return 9_000;
    case "needs_input":
      return 8_000;
    case "failed":
      return 7_000;
    case "working":
      return 6_000;
    case "done":
      return 5_000;
    case "idle":
      return 4_000;
  }
}

export function choosePrimarySession(sessions: ClaudeSession[]): ClaudeSession {
  const sorted = [...sessions].sort(
    (left, right) => phaseScore(right.phase) - phaseScore(left.phase) || right.updatedAt - left.updatedAt
  );
  const primary = sorted[0];
  if (!primary) throw new Error("Cannot choose a primary session from an empty project");
  return primary;
}

export async function buildProjects(sessions: ClaudeSession[], settings: GlobalSettings): Promise<ProjectState[]> {
  const canonical = await mapWithConcurrency(sessions, 6, async (session) => ({
    session,
    project: await canonicalizeProject(session.cwd, settings.groupWorktrees)
  }));
  const groups = new Map<string, { project: CanonicalProject; sessions: ClaudeSession[] }>();
  for (const candidate of canonical) {
    if (!candidate) continue;
    const group = groups.get(candidate.project.projectId) ?? { project: candidate.project, sessions: [] };
    group.sessions.push(candidate.session);
    groups.set(candidate.project.projectId, group);
  }

  const projects: ProjectState[] = [];
  for (const group of groups.values()) {
    const primary = choosePrimarySession(group.sessions);
    projects.push({
      projectId: group.project.projectId,
      projectRoot: group.project.projectRoot,
      identityAnchor: group.project.identityAnchor,
      displayName: path.basename(group.project.projectRoot) || group.project.projectRoot,
      sessions: group.sessions,
      primarySessionId: primary.sessionId,
      phase: primary.phase,
      stale: !!primary.stale,
      attentionCount: group.sessions.filter(sessionNeedsAttention).length,
      recencyAt: Math.max(...group.sessions.map((session) => session.updatedAt))
    });
  }
  return projects.sort(compareProjects);
}

export function isUnderway(project: ProjectState, settings: GlobalSettings, now = Date.now()): boolean {
  if (ATTENTION_PHASES.has(project.phase) || project.phase === "working") return true;
  if (project.phase === "done" || project.phase === "failed") {
    return now - project.recencyAt <= settings.doneGraceHours * 3_600_000;
  }
  return now - project.recencyAt <= settings.recentHorizonDays * 86_400_000;
}

function projectPriority(project: ProjectState): number {
  switch (project.phase) {
    case "needs_approval":
      return 90;
    case "failed":
      return 80;
    case "needs_input":
      return 70;
    case "working":
      return 50;
    case "done":
      return 20;
    case "idle":
      return 10;
  }
}

export function compareProjects(left: ProjectState, right: ProjectState): number {
  return projectPriority(right) - projectPriority(left) || right.recencyAt - left.recencyAt;
}

/**
 * Sticky slot assignment: a project keeps its slot while it stays underway;
 * new projects claim the lowest free slot; when everything is full, a project
 * that needs attention may evict an idle/done project (never a working or
 * attention-needing one). Mutates `slots` in place and reports whether it
 * changed. Slot keys are stringified indices 0..autoSlotCount-1.
 */
export function reconcileSlots(
  slots: Record<string, string>,
  underway: ProjectState[],
  autoSlotCount: number
): boolean {
  let changed = false;
  const byId = new Map(underway.map((project) => [project.projectId, project]));

  const seen = new Set<string>();
  for (const [slot, projectId] of Object.entries(slots)) {
    const index = Number.parseInt(slot, 10);
    const valid =
      Number.isInteger(index) &&
      index >= 0 &&
      index < autoSlotCount &&
      byId.has(projectId) &&
      !seen.has(projectId);
    if (!valid) {
      delete slots[slot];
      changed = true;
      continue;
    }
    seen.add(projectId);
  }

  const unassigned = underway.filter((project) => !seen.has(project.projectId)).sort(compareProjects);
  for (const project of unassigned) {
    let slot = firstFreeSlot(slots, autoSlotCount);
    if (slot === undefined && sessionNeedsAttentionPhase(project.phase)) {
      slot = evictableSlot(slots, byId);
    }
    if (slot === undefined) continue;
    slots[slot] = project.projectId;
    seen.add(project.projectId);
    changed = true;
  }
  return changed;
}

function sessionNeedsAttentionPhase(phase: SessionPhase): boolean {
  return ATTENTION_PHASES.has(phase);
}

function firstFreeSlot(slots: Record<string, string>, autoSlotCount: number): string | undefined {
  for (let index = 0; index < autoSlotCount; index += 1) {
    if (!slots[String(index)]) return String(index);
  }
  return undefined;
}

function evictableSlot(slots: Record<string, string>, byId: Map<string, ProjectState>): string | undefined {
  let candidate: { slot: string; recencyAt: number } | undefined;
  for (const [slot, projectId] of Object.entries(slots)) {
    const project = byId.get(projectId);
    if (!project || (project.phase !== "idle" && project.phase !== "done")) continue;
    if (!candidate || project.recencyAt < candidate.recencyAt) candidate = { slot, recencyAt: project.recencyAt };
  }
  return candidate?.slot;
}

async function mapWithConcurrency<T, U>(items: T[], limit: number, mapper: (item: T) => Promise<U>): Promise<Array<U | undefined>> {
  const results: Array<U | undefined> = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await mapper(item);
      } catch {
        results[index] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
