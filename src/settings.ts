import type { JsonObject } from "@elgato/utils";

export interface GlobalSettings {
  version: 1;
  editorCommand: string;
  editorArgs: string[];
  recentHorizonDays: number;
  doneGraceHours: number;
  freshMinutes: number;
  staleMinutes: number;
  holdMilliseconds: number;
  staleWorkingMinutes: number;
  sessionTtlHours: number;
  autoSlotCount: number;
  groupWorktrees: boolean;
  notifyBridgeEnabled: boolean;
  redactContentInLogs: boolean;
}

export type GlobalSettingsJson = GlobalSettings & JsonObject;

export interface SlotSettings {
  slotMode?: "auto" | "pinned";
  slotIndex?: number;
  pinnedProjectRoot?: string;
  showFreshness?: boolean;
  showAttentionCount?: boolean;
  displayNameOverride?: string;
}

export type SlotSettingsJson = SlotSettings & JsonObject;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  version: 1,
  editorCommand: "code",
  editorArgs: [],
  recentHorizonDays: 14,
  doneGraceHours: 24,
  freshMinutes: 15,
  staleMinutes: 120,
  holdMilliseconds: 650,
  staleWorkingMinutes: 120,
  sessionTtlHours: 24,
  autoSlotCount: 4,
  groupWorktrees: true,
  notifyBridgeEnabled: true,
  redactContentInLogs: true
};

const numberSetting = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const booleanSetting = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const stringSetting = (value: unknown, fallback: string, maxLength: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return fallback;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || fallback;
};

export function normalizeGlobalSettings(input: Partial<GlobalSettings> | undefined): GlobalSettings {
  const raw = input ?? {};
  const freshMinutes = numberSetting(raw.freshMinutes, 15, 1, 1440);
  const staleMinutes = Math.max(freshMinutes + 1, numberSetting(raw.staleMinutes, 120, 2, 10080));
  return {
    version: 1,
    editorCommand: stringSetting(raw.editorCommand, "code", 32_768),
    editorArgs: Array.isArray(raw.editorArgs)
      ? raw.editorArgs
          .filter((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))
          .map((arg) => arg.slice(0, 32_768))
          .slice(0, 16)
      : [],
    recentHorizonDays: numberSetting(raw.recentHorizonDays, 14, 1, 365),
    doneGraceHours: numberSetting(raw.doneGraceHours, 24, 0, 720),
    freshMinutes,
    staleMinutes,
    holdMilliseconds: numberSetting(raw.holdMilliseconds, 650, 300, 3000),
    staleWorkingMinutes: numberSetting(raw.staleWorkingMinutes, 120, 5, 1440),
    sessionTtlHours: numberSetting(raw.sessionTtlHours, 24, 1, 168),
    autoSlotCount: Math.floor(numberSetting(raw.autoSlotCount, 4, 1, 32)),
    groupWorktrees: booleanSetting(raw.groupWorktrees, true),
    notifyBridgeEnabled: booleanSetting(raw.notifyBridgeEnabled, true),
    redactContentInLogs: booleanSetting(raw.redactContentInLogs, true)
  };
}

export function normalizeSlotSettings(settings: SlotSettings | undefined): Required<SlotSettings> {
  return {
    slotMode: settings?.slotMode === "pinned" ? "pinned" : "auto",
    slotIndex: Number.isInteger(settings?.slotIndex) ? Math.max(0, Math.min(31, settings?.slotIndex ?? 0)) : 0,
    pinnedProjectRoot:
      typeof settings?.pinnedProjectRoot === "string" && !settings.pinnedProjectRoot.includes("\0")
        ? settings.pinnedProjectRoot.slice(0, 32_768)
        : "",
    showFreshness: settings?.showFreshness !== false,
    showAttentionCount: settings?.showAttentionCount !== false,
    displayNameOverride:
      typeof settings?.displayNameOverride === "string"
        ? settings.displayNameOverride.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 48)
        : ""
  };
}
