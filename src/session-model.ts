import type { ClaudeSession, SessionPhase } from "./domain.js";
import type { NotifyEvent } from "./notify-bridge.js";

/**
 * Notification types that carry no attention request; they only prove the
 * session is alive. Everything else that arrives as a `notification` event is
 * treated as needing the user (unknown types degrade safely to needs_input).
 */
const PASSIVE_NOTIFICATION_TYPES = new Set([
  "auth_success",
  "elicitation_complete",
  "elicitation_response",
  "agent_completed"
]);

const RESUMABLE_PHASES = new Set<SessionPhase>(["needs_approval", "needs_input", "idle"]);

export interface ApplyResult {
  /** Anything observable changed; re-render. */
  changed: boolean;
  /** Membership or phase changed; persist the cache. */
  persist: boolean;
}

const NO_CHANGE: ApplyResult = { changed: false, persist: false };

export function applySessionEvent(
  sessions: Record<string, ClaudeSession>,
  event: NotifyEvent,
  now = Date.now()
): ApplyResult {
  const parsed = Date.parse(event.observedAt);
  const observedAt = Number.isFinite(parsed) ? Math.min(parsed, now) : now;

  if (event.type === "session-end") {
    if (!sessions[event.sessionId]) return NO_CHANGE;
    delete sessions[event.sessionId];
    return { changed: true, persist: true };
  }

  let session = sessions[event.sessionId];
  let added = false;
  if (!session) {
    session = {
      sessionId: event.sessionId,
      cwd: event.cwd,
      phase: "idle",
      startedAt: observedAt,
      updatedAt: observedAt
    };
    sessions[event.sessionId] = session;
    added = true;
  }

  const phaseBefore = session.phase;
  session.cwd = event.cwd;
  session.updatedAt = Math.max(session.updatedAt, observedAt);

  switch (event.type) {
    case "session-start":
      // "clear" resets the conversation; "compact"/"resume" continue existing
      // work mid-flight and must not knock a working session back to idle.
      if (added || event.source === "clear" || event.source === "startup") session.phase = "idle";
      break;
    case "prompt-submit":
      session.phase = "working";
      clearAttention(session);
      break;
    case "notification":
      if (event.notificationType === "permission_prompt") {
        session.phase = "needs_approval";
        setAttention(session, event);
      } else if (!event.notificationType || !PASSIVE_NOTIFICATION_TYPES.has(event.notificationType)) {
        session.phase = "needs_input";
        setAttention(session, event);
      }
      break;
    case "post-tool":
      // A tool finished, so any pending approval or input request was resolved
      // and the session is provably working again.
      if (RESUMABLE_PHASES.has(session.phase)) {
        session.phase = "working";
        clearAttention(session);
      }
      break;
    case "stop":
      session.phase = "done";
      clearAttention(session);
      break;
    case "stop-failure":
      session.phase = "failed";
      break;
  }

  const persist = added || session.phase !== phaseBefore;
  return { changed: true, persist };
}

function setAttention(session: ClaudeSession, event: NotifyEvent): void {
  session.stale = undefined;
  if (event.notificationType) session.notificationType = event.notificationType;
  else delete session.notificationType;
  if (event.message) session.message = event.message;
  else delete session.message;
}

function clearAttention(session: ClaudeSession): void {
  session.stale = undefined;
  delete session.notificationType;
  delete session.message;
}

export interface GcOptions {
  staleWorkingMinutes: number;
  sessionTtlHours: number;
}

export function gcSessions(sessions: Record<string, ClaudeSession>, options: GcOptions, now = Date.now()): ApplyResult {
  let changed = false;
  let persist = false;
  for (const session of Object.values(sessions)) {
    if (now - session.updatedAt > options.sessionTtlHours * 3_600_000) {
      // No SessionEnd ever arrived (crash, kill); expire the session.
      delete sessions[session.sessionId];
      changed = true;
      persist = true;
      continue;
    }
    if (session.phase === "working" && !session.stale && now - session.updatedAt > options.staleWorkingMinutes * 60_000) {
      session.stale = true;
      changed = true;
    }
  }
  return { changed, persist };
}

/** Hold-to-acknowledge: settle finished sessions back to idle. */
export function acknowledgeSessions(sessions: ClaudeSession[]): boolean {
  let changed = false;
  for (const session of sessions) {
    if (session.phase === "done" || session.phase === "failed") {
      session.phase = "idle";
      clearAttention(session);
      changed = true;
    }
  }
  return changed;
}
