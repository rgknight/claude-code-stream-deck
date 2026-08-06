import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildHelperCommand,
  checkHookSettings,
  HOOK_EVENTS,
  mergeHookSettings,
  QUESTION_TOOL_MATCHER,
  removeHookSettings
} from "../src/hooks-installer.js";

const COMMAND = 'python3 "$HOME/Library/Application Support/ClaudeStreamDeck/claude_streamdeck_notify.py"';

describe("hook settings merge", () => {
  it("installs an entry for every event into empty settings", () => {
    const { settings, changed } = mergeHookSettings({}, COMMAND);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]?.[0]?.hooks[0]).toEqual({ type: "command", command: COMMAND, timeout: 10 });
    }
    expect(checkHookSettings(settings)).toBe("installed");
  });

  it("is idempotent on a second run", () => {
    const first = mergeHookSettings({}, COMMAND);
    const second = mergeHookSettings(first.settings, COMMAND);
    expect(second.changed).toBe(false);
  });

  it("preserves unrelated settings and existing user hooks", () => {
    const existing = {
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }]
      }
    };
    const { settings } = mergeHookSettings(structuredClone(existing), COMMAND);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual(existing.permissions);
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toContain("afplay");
    expect(hooks.Stop?.[1]?.hooks[0]?.command).toBe(COMMAND);
    // The user's own PreToolUse group is untouched; ours is appended beside it.
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("./lint.sh");
    expect(hooks.PreToolUse?.[1]?.matcher).toBe(QUESTION_TOOL_MATCHER);
  });

  it("scopes PreToolUse to the question tools and leaves other events matcher-less", () => {
    const { settings } = mergeHookSettings({}, COMMAND);
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    expect(hooks.PreToolUse?.[0]?.matcher).toBe(QUESTION_TOOL_MATCHER);
    expect(QUESTION_TOOL_MATCHER).toContain("AskUserQuestion");
    for (const event of HOOK_EVENTS) {
      if (event === "PreToolUse") continue;
      expect(hooks[event]?.[0]).not.toHaveProperty("matcher");
    }
  });

  it("repairs a stale PreToolUse matcher on a group that is only ours", () => {
    const stale = mergeHookSettings({}, COMMAND).settings;
    const groups = (stale.hooks as Record<string, Array<{ matcher?: string }>>).PreToolUse;
    groups![0]!.matcher = "AskUserQuestion";
    // A matcher that no longer covers every question tool is not a full install.
    expect(checkHookSettings(stale)).toBe("partial");
    const { settings, changed } = mergeHookSettings(structuredClone(stale), COMMAND);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse?.[0]?.matcher).toBe(QUESTION_TOOL_MATCHER);
    expect(checkHookSettings(settings)).toBe("installed");
  });

  it("updates a stale command in place instead of duplicating", () => {
    const stale = mergeHookSettings({}, "python3 /old/claude_streamdeck_notify.py");
    const updated = mergeHookSettings(stale.settings, COMMAND);
    expect(updated.changed).toBe(true);
    const hooks = updated.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe(COMMAND);
  });

  it("reports partial installs", () => {
    const { settings } = mergeHookSettings({}, COMMAND);
    const hooks = settings.hooks as Record<string, unknown>;
    delete hooks.Notification;
    expect(checkHookSettings(settings)).toBe("partial");
    expect(checkHookSettings({})).toBe("missing");
    expect(checkHookSettings({ hooks: {} })).toBe("missing");
  });

  it("uninstalls cleanly while preserving user hooks", () => {
    const base = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "afplay ding.aiff" }] }]
      }
    };
    const merged = mergeHookSettings(structuredClone(base), COMMAND);
    const removed = removeHookSettings(merged.settings);
    expect(removed.changed).toBe(true);
    expect(checkHookSettings(removed.settings)).toBe("missing");
    const hooks = removed.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toContain("afplay");
    expect(hooks.SessionStart).toBeUndefined();
  });
});

describe("helper command", () => {
  it("quotes the helper path and substitutes $HOME on POSIX", () => {
    if (process.platform === "win32") return;
    const home = os.homedir();
    const command = buildHelperCommand(["python3"], `${home}/Library/Application Support/ClaudeStreamDeck/claude_streamdeck_notify.py`);
    expect(command).toBe('python3 "$HOME/Library/Application Support/ClaudeStreamDeck/claude_streamdeck_notify.py"');
    expect(command).not.toContain(home);
  });
});
