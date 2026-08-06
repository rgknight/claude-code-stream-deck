import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { HooksStatus } from "./domain.js";
import { claudeHome } from "./paths.js";

const execFileAsync = promisify(execFile);

export const HELPER_FILENAME = "claude_streamdeck_notify.py";
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "SessionEnd"
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Tools that park a session waiting on the user without any notification. */
export const QUESTION_TOOL_MATCHER = "AskUserQuestion|ExitPlanMode";

/**
 * PreToolUse fires for every tool call, so ours is scoped to the handful of
 * tools whose prompts would otherwise be invisible. Every other event is
 * installed matcher-less, which Claude Code reads as "all invocations".
 */
const HOOK_MATCHERS: Partial<Record<HookEvent, string>> = { PreToolUse: QUESTION_TOOL_MATCHER };
const HOOK_TIMEOUT_SECONDS = 10;

export interface HooksInstallResult {
  installed: boolean;
  configPath: string;
  backupPath?: string;
  message: string;
}

export async function findPython(): Promise<string[]> {
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python", ""]] : [["python3", ""], ["python", ""]];
  for (const [command, launcherArg] of candidates) {
    if (!command) continue;
    try {
      const args = [...(launcherArg ? [launcherArg] : []), "--version"];
      await execFileAsync(command, args, { timeout: 5_000, windowsHide: true });
      return launcherArg ? [command, launcherArg] : [command];
    } catch {
      // Try the next launcher.
    }
  }
  throw new Error("Python 3 is required for the Claude Code notify helper");
}

/**
 * Builds the shell command string stored in settings.json. Hook commands run
 * through a shell, so the helper path is quoted (the data directory contains a
 * space on macOS) and, on POSIX, expressed via $HOME so the settings file
 * stays portable and free of literal user paths.
 */
export function buildHelperCommand(launcher: string[], helperTarget: string): string {
  let target = helperTarget;
  if (process.platform !== "win32") {
    const home = os.homedir();
    if (target.startsWith(`${home}${path.sep}`)) target = `$HOME${target.slice(home.length)}`;
  }
  return [...launcher, `"${target}"`].join(" ");
}

interface HookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOurHook(entry: unknown): entry is HookEntry {
  return isRecord(entry) && typeof entry.command === "string" && entry.command.includes(HELPER_FILENAME);
}

export interface MergeResult {
  settings: Record<string, unknown>;
  changed: boolean;
}

/**
 * Idempotent, non-destructive merge of the monitor's hook entries into a
 * parsed settings.json object. Existing user hooks, matchers, and unrelated
 * keys are preserved; our entries are recognized by the helper filename and
 * updated in place when the command changes.
 */
export function mergeHookSettings(settings: unknown, command: string): MergeResult {
  const base: Record<string, unknown> = isRecord(settings) ? settings : {};
  const hooks: Record<string, unknown> = isRecord(base.hooks) ? (base.hooks as Record<string, unknown>) : {};
  base.hooks = hooks;
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const matcher = HOOK_MATCHERS[event];
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    hooks[event] = groups;
    let found = false;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const ours = group.hooks.filter(isOurHook);
      if (ours.length === 0) continue;
      // A group holding nothing but our entries is ours to retarget; one where
      // the user parked their own hooks alongside ours keeps its matcher.
      const retargetable = ours.length === group.hooks.length;
      if (matcher && group.matcher !== matcher && !retargetable) continue;
      found = true;
      if (matcher && group.matcher !== matcher) {
        group.matcher = matcher;
        changed = true;
      }
      for (const entry of ours) {
        if (entry.type !== "command" || entry.command !== command || entry.timeout !== HOOK_TIMEOUT_SECONDS) {
          entry.type = "command";
          entry.command = command;
          entry.timeout = HOOK_TIMEOUT_SECONDS;
          changed = true;
        }
      }
    }
    if (!found) {
      groups.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }]
      });
      changed = true;
    }
  }
  return { settings: base, changed };
}

/** Removes the monitor's hook entries; prunes groups and events left empty. */
export function removeHookSettings(settings: unknown): MergeResult {
  const base: Record<string, unknown> = isRecord(settings) ? settings : {};
  const hooks = isRecord(base.hooks) ? (base.hooks as Record<string, unknown>) : undefined;
  if (!hooks) return { settings: base, changed: false };
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const pruned = groups.filter((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return true;
      const kept = group.hooks.filter((entry) => !isOurHook(entry));
      if (kept.length !== group.hooks.length) changed = true;
      group.hooks = kept;
      return kept.length > 0;
    });
    if (pruned.length !== groups.length) changed = true;
    if (pruned.length === 0) delete hooks[event];
    else hooks[event] = pruned;
  }
  if (isRecord(base.hooks) && Object.keys(base.hooks as Record<string, unknown>).length === 0) delete base.hooks;
  return { settings: base, changed };
}

export function checkHookSettings(settings: unknown): HooksStatus {
  if (!isRecord(settings)) return "missing";
  const hooks = isRecord(settings.hooks) ? (settings.hooks as Record<string, unknown>) : undefined;
  if (!hooks) return "missing";
  let installedCount = 0;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const matcher = HOOK_MATCHERS[event];
    // A scoped event only counts when the matcher still covers the tools we
    // need, so a narrowed or stale matcher reports partial and invites a repair.
    const present = groups.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some(isOurHook) &&
        (!matcher || group.matcher === matcher)
    );
    if (present) installedCount += 1;
  }
  if (installedCount === HOOK_EVENTS.length) return "installed";
  if (installedCount > 0) return "partial";
  return "missing";
}

function settingsPath(): string {
  return path.join(claudeHome(), "settings.json");
}

async function readSettingsFile(configPath: string): Promise<{ value: unknown } | { missing: true } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { error: `Could not read ${configPath}` };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { error: "settings.json is not valid JSON; it was left unchanged." };
  }
}

async function writeSettingsFile(configPath: string, value: Record<string, unknown>, hadOriginal: boolean): Promise<string | undefined> {
  await mkdir(path.dirname(configPath), { recursive: true });
  let backupPath: string | undefined;
  if (hadOriginal) {
    backupPath = `${configPath}.streamdeck-backup-${Date.now()}`;
    const original = await readFile(configPath).catch(() => undefined);
    if (original) await writeFile(backupPath, original, { mode: 0o600 });
    else backupPath = undefined;
  }
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, configPath);
  return backupPath;
}

export async function installHooks(pluginRoot: string, dataDirectory: string): Promise<HooksInstallResult> {
  const launcher = await findPython();
  const helperSource = path.join(pluginRoot, "helpers", HELPER_FILENAME);
  const helperTarget = path.join(dataDirectory, HELPER_FILENAME);
  await mkdir(dataDirectory, { recursive: true });
  await copyFile(helperSource, helperTarget);
  const command = buildHelperCommand(launcher, helperTarget);

  const configPath = settingsPath();
  const read = await readSettingsFile(configPath);
  if ("error" in read) return { installed: false, configPath, message: read.error };
  const hadOriginal = !("missing" in read);
  const merged = mergeHookSettings(hadOriginal ? read.value : {}, command);
  if (!merged.changed) {
    return { installed: true, configPath, message: "Claude Code hooks are already installed." };
  }
  const backupPath = await writeSettingsFile(configPath, merged.settings, hadOriginal);
  return {
    installed: true,
    configPath,
    ...(backupPath ? { backupPath } : {}),
    message: "Claude Code hooks installed. Running sessions pick them up automatically."
  };
}

export async function uninstallHooks(): Promise<HooksInstallResult> {
  const configPath = settingsPath();
  const read = await readSettingsFile(configPath);
  if ("missing" in read) return { installed: false, configPath, message: "No settings.json found; nothing to remove." };
  if ("error" in read) return { installed: false, configPath, message: read.error };
  const removed = removeHookSettings(read.value);
  if (!removed.changed) return { installed: false, configPath, message: "No monitor hooks were present." };
  const backupPath = await writeSettingsFile(configPath, removed.settings, true);
  return {
    installed: false,
    configPath,
    ...(backupPath ? { backupPath } : {}),
    message: "Monitor hooks removed from settings.json."
  };
}

export async function checkHooks(): Promise<HooksStatus> {
  const read = await readSettingsFile(settingsPath());
  if ("missing" in read) return "missing";
  if ("error" in read) return "unreadable";
  return checkHookSettings(read.value);
}
