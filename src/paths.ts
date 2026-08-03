import os from "node:os";
import path from "node:path";

export function dataDirectory(): string {
  const override = process.env.CLAUDE_STREAMDECK_DATA_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ClaudeStreamDeck");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ClaudeStreamDeck");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "claude-streamdeck");
}

export function spoolDirectory(): string {
  return path.join(dataDirectory(), "spool");
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
