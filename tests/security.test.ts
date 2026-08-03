import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseNotifyEvent } from "../src/notify-bridge.js";
import { splitProjectName } from "../src/renderer.js";
import { normalizeGlobalSettings, normalizeSlotSettings } from "../src/settings.js";

describe("security boundaries", () => {
  it("normalizes untrusted global settings without truthy coercion", () => {
    const settings = normalizeGlobalSettings({
      editorCommand: "bad\0editor",
      notifyBridgeEnabled: "no" as unknown as boolean,
      groupWorktrees: "yes" as unknown as boolean,
      freshMinutes: 120,
      staleMinutes: 2,
      autoSlotCount: 500,
      editorArgs: ["ok", "bad\0arg", 42 as unknown as string]
    });
    expect(settings.editorCommand).toBe("code");
    expect(settings.notifyBridgeEnabled).toBe(true);
    expect(settings.groupWorktrees).toBe(true);
    expect(settings.staleMinutes).toBe(121);
    expect(settings.autoSlotCount).toBe(32);
    expect(settings.editorArgs).toEqual(["ok"]);
  });

  it("bounds slot settings and removes control characters", () => {
    const slot = normalizeSlotSettings({
      slotIndex: 100,
      pinnedProjectRoot: "bad\0root",
      displayNameOverride: "hello\u0001world"
    });
    expect(slot.slotIndex).toBe(31);
    expect(slot.pinnedProjectRoot).toBe("");
    expect(slot.displayNameOverride).toBe("hello world");
    expect(splitProjectName("safe\u0001title").join(" ")).not.toContain("\u0001");
  });

  it("accepts only bounded, versioned local notify events", () => {
    const base = {
      version: 2,
      type: "notification",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: process.cwd(),
      observedAt: new Date().toISOString()
    };
    expect(parseNotifyEvent(base).sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(() => parseNotifyEvent({ ...base, version: 1 })).toThrow(/version/i);
    expect(() => parseNotifyEvent({ ...base, type: "agent-turn-complete" })).toThrow(/event type/i);
    expect(() => parseNotifyEvent({ ...base, sessionId: "../escape" })).toThrow(/session ID/i);
    expect(() => parseNotifyEvent({ ...base, cwd: "relative/path" })).toThrow(/absolute cwd/i);
  });

  it("drops unknown fields and truncates message text by UTF-8 byte length", () => {
    const event = parseNotifyEvent({
      version: 2,
      type: "notification",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: process.cwd(),
      observedAt: new Date().toISOString(),
      notificationType: "permission_prompt",
      message: "😀".repeat(10_000),
      transcript_path: "/somewhere/private.jsonl",
      extra: { nested: true }
    });
    expect(Buffer.byteLength(event.message ?? "", "utf8")).toBeLessThanOrEqual(1024);
    expect(event.message).not.toContain("�");
    expect(event.notificationType).toBe("permission_prompt");
    expect("transcript_path" in event).toBe(false);
    expect("extra" in event).toBe(false);
  });

  it("ships the Property Inspector with a restrictive content policy", async () => {
    const html = await readFile("com.claudecode.monitor.sdPlugin/ui/property-inspector.html", "utf8");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src ws://127.0.0.1:*");
  });
});
