export type BridgeState = "starting" | "running" | "error";
export type HooksStatus = "installed" | "partial" | "missing" | "unreadable" | "unknown";
export type FreshnessState = "fresh" | "aging" | "stale";

export type SessionPhase = "idle" | "working" | "needs_input" | "needs_approval" | "done" | "failed";

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  phase: SessionPhase;
  startedAt: number;
  updatedAt: number;
  notificationType?: string | undefined;
  message?: string | undefined;
  stale?: boolean | undefined;
}

export interface ProjectState {
  projectId: string;
  projectRoot: string;
  identityAnchor: string;
  displayName: string;
  sessions: ClaudeSession[];
  primarySessionId: string;
  phase: SessionPhase;
  stale: boolean;
  attentionCount: number;
  recencyAt: number;
}

export interface DisplayState {
  label: string;
  glyph: string;
  color: string;
  background: string;
  urgent: boolean;
  stale: boolean;
}

export interface CacheFile {
  schemaVersion: 2;
  sessions: Record<string, ClaudeSession>;
  projects: ProjectState[];
  slots: Record<string, string>;
}
