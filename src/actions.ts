import streamDeck, {
  action,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { coordinator } from "./coordinator.js";
import { renderProjectSvg, renderUtilitySvg, svgDataUrl } from "./renderer.js";
import { normalizeSlotSettings, type SlotSettingsJson } from "./settings.js";

const SESSION_UUID = "com.claudecode.monitor.session-slot";
const HEALTH_UUID = "com.claudecode.monitor.health";

function coordinateIndex(action: KeyAction): number {
  const coordinates = action.coordinates;
  return coordinates ? coordinates.row * action.device.size.columns + coordinates.column : 0;
}

async function sendInspectorState(project?: Parameters<typeof coordinator.inspectorState>[0]): Promise<void> {
  await streamDeck.ui.sendToPropertyInspector(coordinator.inspectorState(project));
}

@action({ UUID: SESSION_UUID })
export class SessionSlotAction extends SingletonAction<SlotSettingsJson> {
  readonly #pressedAt = new Map<string, number>();
  readonly #rendered = new Map<string, { svg: string; at: number }>();
  #renderScheduled = false;

  constructor() {
    super();
    coordinator.onChange(() => this.#scheduleRender());
  }

  override async onWillAppear(event: WillAppearEvent<SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    await this.#render(event.action, event.payload.settings);
  }

  override onKeyDown(event: KeyDownEvent<SlotSettingsJson>): void {
    this.#pressedAt.set(event.action.id, Date.now());
  }

  override async onKeyUp(event: KeyUpEvent<SlotSettingsJson>): Promise<void> {
    const started = this.#pressedAt.get(event.action.id) ?? Date.now();
    this.#pressedAt.delete(event.action.id);
    const settings = normalizeSlotSettings(event.payload.settings);
    const project = coordinator.projectForSlot(event.payload.settings, coordinateIndex(event.action));
    const held = Date.now() - started >= coordinator.settings.holdMilliseconds;
    try {
      if (!project) throw new Error("No Claude Code session is assigned to this key");
      if (!held) {
        await coordinator.openProject(project);
        return;
      }
      if (project.phase === "done" || project.phase === "failed") {
        await coordinator.acknowledgeProject(project);
      } else if (settings.slotMode === "auto") {
        await event.action.setSettings({
          ...event.payload.settings,
          slotMode: "pinned",
          pinnedProjectRoot: project.projectRoot
        });
        this.#scheduleRender();
      } else {
        await event.action.setSettings({ ...event.payload.settings, slotMode: "auto", pinnedProjectRoot: "" });
        this.#scheduleRender();
      }
    } catch (error) {
      streamDeck.logger.warn(error instanceof Error ? error.message : "Session key action failed");
      await event.action.showAlert();
    }
  }

  override async onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = await event.action.getSettings<SlotSettingsJson>();
    await sendInspectorState(coordinator.projectForSlot(settings, coordinateIndex(event.action)));
  }

  override async onSendToPlugin(event: SendToPluginEvent<JsonValue, SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = await event.action.getSettings<SlotSettingsJson>();
    await coordinator.handleInspectorMessage(
      event.action,
      event.payload,
      coordinator.projectForSlot(settings, coordinateIndex(event.action))
    );
  }

  #scheduleRender(): void {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    setTimeout(() => {
      this.#renderScheduled = false;
      void this.#renderAll();
    }, 100);
  }

  async #renderAll(): Promise<void> {
    const renders: Array<Promise<void>> = [];
    for (const instance of this.actions) {
      if (instance.isKey()) renders.push(instance.getSettings<SlotSettingsJson>().then((settings) => this.#render(instance, settings)));
    }
    await Promise.all(renders);
  }

  async #render(key: KeyAction<SlotSettingsJson>, raw: SlotSettingsJson): Promise<void> {
    const settings = normalizeSlotSettings(raw);
    const project = coordinator.projectForSlot(raw, coordinateIndex(key));
    const svg = renderProjectSvg({
      project,
      bridge: coordinator.bridge,
      hooks: coordinator.hooksStatus,
      freshMinutes: coordinator.settings.freshMinutes,
      staleMinutes: coordinator.settings.staleMinutes,
      pinned: settings.slotMode === "pinned",
      showFreshness: settings.showFreshness,
      showAttentionCount: settings.showAttentionCount,
      displayNameOverride: settings.displayNameOverride
    });
    const previous = this.#rendered.get(key.id);
    if (previous?.svg === svg || (previous && Date.now() - previous.at < 500)) return;
    this.#rendered.set(key.id, { svg, at: Date.now() });
    await key.setImage(svgDataUrl(svg));
    await key.setTitle(undefined);
  }
}

@action({ UUID: HEALTH_UUID })
export class HealthAction extends SingletonAction<JsonObject> {
  constructor() {
    super();
    coordinator.onChange(() => void this.#render());
  }

  override async onWillAppear(event: WillAppearEvent<JsonObject>): Promise<void> {
    if (event.action.isKey()) await this.#renderKey(event.action);
  }

  override async onKeyDown(event: KeyDownEvent<JsonObject>): Promise<void> {
    try {
      await coordinator.refreshHealth();
      await event.action.showOk();
    } catch (error) {
      streamDeck.logger.warn(error instanceof Error ? error.message : "Health refresh failed");
      await event.action.showAlert();
    }
  }

  override async onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<JsonObject>): Promise<void> {
    if (!event.action.isKey()) return;
    await sendInspectorState();
  }

  override async onSendToPlugin(event: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
    if (!event.action.isKey()) return;
    await coordinator.handleInspectorMessage(event.action, event.payload);
  }

  async #render(): Promise<void> {
    const renders: Array<Promise<void>> = [];
    for (const instance of this.actions) if (instance.isKey()) renders.push(this.#renderKey(instance));
    await Promise.all(renders);
  }

  async #renderKey(key: KeyAction<JsonObject>): Promise<void> {
    const hooks = coordinator.hooksStatus;
    const bridgeOk = coordinator.bridge === "running";
    const hooksOk = hooks === "installed" || hooks === "unknown";
    const waiting = coordinator.unassignedAttentionCount;
    let label = "OK";
    let icon: "health" | "warning" = "health";
    let color = "#86EFAC";
    let background = "#0A281B";
    if (!bridgeOk) {
      label = "Bridge";
      icon = "warning";
      color = "#FBBF24";
      background = "#33270B";
    } else if (!hooksOk) {
      label = "Setup";
      icon = "warning";
      color = "#FBBF24";
      background = "#33270B";
    } else if (waiting > 0) {
      label = `+${waiting} waiting`;
      icon = "warning";
      color = "#FDE68A";
      background = "#3B2A0B";
    }
    await key.setImage(svgDataUrl(renderUtilitySvg(label, icon, color, background)));
    await key.setTitle(undefined);
  }
}
