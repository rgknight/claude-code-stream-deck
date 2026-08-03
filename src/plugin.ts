import streamDeck from "@elgato/streamdeck";

import { HealthAction, SessionSlotAction } from "./actions.js";
import { coordinator } from "./coordinator.js";

await coordinator.preload();

streamDeck.actions.registerAction(new SessionSlotAction());
streamDeck.actions.registerAction(new HealthAction());

streamDeck.system.onSystemDidWakeUp(() => void coordinator.refreshHealth());

await streamDeck.connect();
await coordinator.start();
