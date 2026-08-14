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
  /** When a background agent was last launched; unset once the session settles. */
  backgroundAt?: number | undefined;
  /** When the main loop stopped while background agents were still running. */
  stoppedAt?: number | undefined;
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
  /** Accent color: icon, label, and text ink. On solid keys this is a dark ink. */
  color: string;
  /** Key background. On solid keys this is a bright, saturated fill. */
  background: string;
  urgent: boolean;
  stale: boolean;
  /** Fill the whole key with `background` instead of a dark card with accents. */
  solid: boolean;
}

export interface CacheFile {
  schemaVersion: 2;
  sessions: Record<string, ClaudeSession>;
  projects: ProjectState[];
  slots: Record<string, string>;
}
