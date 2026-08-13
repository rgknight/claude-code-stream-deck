import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck, { type Action } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { CacheStore } from "./cache.js";
import type { BridgeState, CacheFile, HooksStatus, ProjectState } from "./domain.js";
import { checkHooks, installHooks, refreshHelper, uninstallHooks } from "./hooks-installer.js";
import { DiagnosticLogger } from "./logger.js";
import { openDirectory, openEditor } from "./native-launch.js";
import { NotifyBridgeServer, type NotifyBridgeHealth, type NotifyEvent } from "./notify-bridge.js";
import { dataDirectory } from "./paths.js";
import { buildProjects, isUnderway, reconcileSlots, sessionNeedsAttention } from "./project-model.js";
import { acknowledgeSessions, applySessionEvent, gcSessions } from "./session-model.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  normalizeGlobalSettings,
  normalizeSlotSettings,
  type GlobalSettings,
  type GlobalSettingsJson,
  type SlotSettings
} from "./settings.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.basename(moduleDirectory) === "bin"
  ? path.dirname(moduleDirectory)
  : path.resolve(moduleDirectory, "..", "com.claudecode.monitor.sdPlugin");

// Also drives the background-agent settle, so it ticks well inside the
// shortest settle window a user can configure.
const GC_INTERVAL_MS = 10_000;

type ChangeListener = () => void;

interface PiMessage {
  op?: string;
}

export class Coordinator {
  readonly #directory = dataDirectory();
  readonly #logger = new DiagnosticLogger(path.join(this.#directory, "logs"), () => false);
  readonly #cacheStore = new CacheStore(this.#directory, this.#logger);
  readonly #notify = new NotifyBridgeServer(this.#directory, this.#logger, (event) => this.#applyNotifyEvent(event));
  readonly #listeners = new Set<ChangeListener>();
  #cache: CacheFile = { schemaVersion: 2, sessions: {}, projects: [], slots: {} };
  #settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
  #bridge: BridgeState = "starting";
  #hooks: HooksStatus = "unknown";
  #projects: ProjectState[] = [];
  #allProjects: ProjectState[] = [];
  #preloaded = false;
  #started = false;
  #lastError = "";
  #gcTimer: NodeJS.Timeout | undefined;
  #savePromise: Promise<void> = Promise.resolve();
  #rebuildPromise: Promise<void> = Promise.resolve();

  get settings(): GlobalSettings {
    return this.#settings;
  }

  get bridge(): BridgeState {
    return this.#bridge;
  }

  get hooksStatus(): HooksStatus {
    return this.#hooks;
  }

  get projects(): readonly ProjectState[] {
    return this.#projects;
  }

  get bridgeHealth(): NotifyBridgeHealth {
    return this.#notify.health;
  }

  /** Underway projects that need attention but hold no key. */
  get unassignedAttentionCount(): number {
    const assigned = new Set(Object.values(this.#cache.slots));
    return this.#projects.filter(
      (project) => !assigned.has(project.projectId) && project.sessions.some(sessionNeedsAttention)
    ).length;
  }

  async preload(): Promise<void> {
    if (this.#preloaded) return;
    await mkdir(this.#directory, { recursive: true });
    this.#cache = await this.#cacheStore.load();
    this.#allProjects = this.#cache.projects;
    this.#projects = this.#allProjects.filter((project) => isUnderway(project, this.#settings));
    this.#preloaded = true;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.preload();
    this.#started = true;
    const stored = await streamDeck.settings.getGlobalSettings<GlobalSettingsJson>();
    this.#settings = normalizeGlobalSettings(stored as Partial<GlobalSettings>);
    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettingsJson>((event) => {
      this.#settings = normalizeGlobalSettings(event.settings as Partial<GlobalSettings>);
      void this.#rebuildProjects();
    });
    if (this.#settings.notifyBridgeEnabled) {
      try {
        await this.#notify.start();
        this.#bridge = "running";
      } catch (error) {
        this.#bridge = "error";
        this.#recordError("Notify bridge failed", error);
      }
    } else {
      this.#bridge = "error";
      this.#lastError = "Notify bridge is disabled in settings";
    }
    this.#hooks = await checkHooks().catch(() => "unknown" as const);
    if (this.#hooks !== "missing") {
      await refreshHelper(PLUGIN_ROOT, this.#directory).catch((error) => this.#recordError("Helper refresh failed", error));
    }
    this.#gcTimer = setInterval(() => void this.#runGc(), GC_INTERVAL_MS);
    this.#gcTimer.unref?.();
    await this.#rebuildProjects();
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  projectForSlot(settings: SlotSettings | undefined, fallbackIndex = 0): ProjectState | undefined {
    const slot = normalizeSlotSettings(settings);
    if (slot.slotMode === "pinned") {
      return this.#allProjects.find(
        (project) => slot.pinnedProjectRoot && samePath(project.projectRoot, slot.pinnedProjectRoot)
      );
    }
    const index = settings?.slotIndex === undefined ? fallbackIndex : slot.slotIndex;
    const projectId = this.#cache.slots[String(index)];
    return projectId ? this.#projects.find((project) => project.projectId === projectId) : undefined;
  }

  /** Focus the session's editor window (VS Code focuses the existing window for an open folder). */
  async openProject(project: ProjectState): Promise<void> {
    const primary = project.sessions.find((session) => session.sessionId === project.primarySessionId);
    let target = project.projectRoot;
    if (primary) target = await realpath(primary.cwd).catch(() => project.projectRoot);
    await openEditor(this.#settings.editorCommand, this.#settings.editorArgs, target);
  }

  /** Hold gesture on a finished key: settle done/failed sessions back to idle. */
  async acknowledgeProject(project: ProjectState): Promise<void> {
    const sessions = project.sessions
      .map((session) => this.#cache.sessions[session.sessionId])
      .filter((session) => session !== undefined);
    if (!acknowledgeSessions(sessions)) return;
    await this.#rebuildProjects();
    this.#save();
  }

  /** Health-key press and wake-up: drain queued events, re-check hooks, rebuild. */
  async refreshHealth(): Promise<void> {
    await this.#notify.drainSpool();
    this.#hooks = await checkHooks().catch(() => "unknown" as const);
    await this.#runGc();
    await this.#rebuildProjects();
  }

  async testEditor(project?: ProjectState): Promise<string> {
    const target = project ?? this.#projects[0];
    if (!target) throw new Error("No project is available for the editor test");
    await this.openProject(target);
    return `Opened ${target.displayName}`;
  }

  inspectorState(project?: ProjectState): Record<string, JsonValue> {
    const bridge = this.#notify.health;
    return {
      type: "state",
      bridge: this.#bridge,
      hooks: this.#hooks,
      lastError: this.#lastError,
      projectCount: this.#projects.length,
      sessionCount: Object.keys(this.#cache.sessions).length,
      dataDirectory: this.#directory,
      bridgeRunning: bridge.running,
      bridgeAccepted: bridge.accepted,
      bridgeRejected: bridge.rejected,
      bridgeSpooled: bridge.spooled,
      ...(project
        ? {
            project: {
              id: project.projectId,
              name: project.displayName,
              root: project.projectRoot,
              phase: project.phase,
              sessionCount: project.sessions.length,
              updatedAt: new Date(project.recencyAt).toISOString()
            }
          }
        : {})
    };
  }

  async handleInspectorMessage(action: Action, payload: JsonValue, project?: ProjectState): Promise<void> {
    void action;
    const message = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as PiMessage) : {};
    try {
      let result = "Done";
      switch (message.op) {
        case "installNotify": {
          const install = await installHooks(PLUGIN_ROOT, this.#directory);
          this.#hooks = await checkHooks().catch(() => "unknown" as const);
          this.#emitChange();
          result = install.message;
          break;
        }
        case "uninstallNotify": {
          const uninstall = await uninstallHooks();
          this.#hooks = await checkHooks().catch(() => "unknown" as const);
          this.#emitChange();
          result = uninstall.message;
          break;
        }
        case "checkHooks":
          this.#hooks = await checkHooks().catch(() => "unknown" as const);
          this.#emitChange();
          result = `Hooks: ${this.#hooks}`;
          break;
        case "openDiagnostics":
          await openDirectory(this.#directory);
          break;
        case "testEditor":
          result = await this.testEditor(project);
          break;
        case "queryState":
        default:
          await streamDeck.ui.sendToPropertyInspector(this.inspectorState(project));
          return;
      }
      await streamDeck.ui.sendToPropertyInspector({ type: "result", ok: true, message: result });
      await streamDeck.ui.sendToPropertyInspector(this.inspectorState(project));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Operation failed";
      await streamDeck.ui.sendToPropertyInspector({ type: "result", ok: false, message: messageText.slice(0, 300) });
    }
  }

  async #applyNotifyEvent(event: NotifyEvent): Promise<void> {
    const result = applySessionEvent(this.#cache.sessions, event);
    if (!result.changed) return;
    await this.#rebuildProjects();
    if (result.persist) this.#save();
  }

  async #runGc(): Promise<void> {
    const result = gcSessions(this.#cache.sessions, this.#settings);
    if (!result.changed) return;
    await this.#rebuildProjects();
    if (result.persist) this.#save();
  }

  #rebuildProjects(): Promise<void> {
    this.#rebuildPromise = this.#rebuildPromise
      .then(() => this.#rebuildInternal())
      .catch((error) => this.#recordError("Project rebuild failed", error));
    return this.#rebuildPromise;
  }

  async #rebuildInternal(): Promise<void> {
    const now = Date.now();
    const projects = await buildProjects(Object.values(this.#cache.sessions), this.#settings);
    this.#allProjects = projects;
    this.#projects = projects.filter((project) => isUnderway(project, this.#settings, now));
    const slotsChanged = reconcileSlots(this.#cache.slots, this.#projects, this.#settings.autoSlotCount);
    this.#cache.projects = projects;
    if (slotsChanged) this.#save();
    this.#emitChange();
  }

  #save(): void {
    this.#savePromise = this.#savePromise.then(() => this.#cacheStore.save(this.#cache)).catch((error) => {
      this.#recordError("Cache write failed", error);
    });
  }

  #recordError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#lastError = `${message}: ${detail}`.slice(0, 300);
    this.#logger.error(message, { error: detail.slice(0, 300) });
  }

  #emitChange(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A key renderer must not break coordinator reconciliation.
      }
    }
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export const coordinator = new Coordinator();
