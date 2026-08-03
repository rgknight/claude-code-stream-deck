/* global WebSocket */
let socket;
let context;
let actionUuid = "";
let actionSettings = {};
let globalSettings = {};
let saveTimer;

const sessionAction = "com.claudecode.monitor.session-slot";

window.connectElgatoStreamDeckSocket = function (port, propertyInspectorUuid, registerEvent, info, rawActionInfo) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
  let actionInfo;
  try {
    actionInfo = JSON.parse(rawActionInfo);
  } catch {
    return;
  }
  context = propertyInspectorUuid;
  actionUuid = typeof actionInfo.action === "string" ? actionInfo.action : "";
  actionSettings = actionInfo.payload && typeof actionInfo.payload.settings === "object"
    ? actionInfo.payload.settings
    : {};
  socket = new WebSocket(`ws://127.0.0.1:${parsedPort}`);
  socket.onopen = () => {
    send({ event: registerEvent, uuid: context });
    send({ event: "getGlobalSettings", context });
    sendToPlugin({ op: "queryState" });
    showRelevantSections();
    renderSettings();
  };
  socket.onmessage = (event) => {
    try {
      receive(JSON.parse(event.data));
    } catch {
      // Ignore malformed local Stream Deck messages.
    }
  };
};

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendToPlugin(payload) {
  send({ event: "sendToPlugin", action: actionUuid, context, payload });
}

function receive(message) {
  if (!message || typeof message !== "object") return;
  if (message.event === "didReceiveGlobalSettings") {
    globalSettings = message.payload.settings || {};
    renderSettings();
    return;
  }
  if (message.event !== "sendToPropertyInspector") return;
  const payload = message.payload || {};
  if (payload.type === "state") renderState(payload);
  if (payload.type === "result") {
    const output = document.getElementById("result");
    output.textContent = payload.message || "Done";
    output.classList.toggle("error", !payload.ok);
  }
}

function showRelevantSections() {
  document.getElementById("project-settings").hidden = actionUuid !== sessionAction;
}

function renderSettings() {
  document.querySelectorAll("[data-scope][data-key]").forEach((control) => {
    const source = control.dataset.scope === "global" ? globalSettings : actionSettings;
    let value = source[control.dataset.key];
    if (value === undefined) return;
    if (control.dataset.type === "boolean") control.checked = Boolean(value);
    else if (control.dataset.type === "list") control.value = Array.isArray(value) ? value.join(" ") : String(value);
    else control.value = String(value);
  });
}

function readValue(control) {
  if (control.dataset.type === "boolean") return control.checked;
  if (control.dataset.type === "number") return Number(control.value);
  if (control.dataset.type === "list") return control.value.trim().split(/\s+/).filter(Boolean);
  return control.value;
}

function scheduleSave(scope) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (scope === "global") send({ event: "setGlobalSettings", context, payload: globalSettings });
    else send({ event: "setSettings", context, payload: actionSettings });
  }, 120);
}

document.addEventListener("input", (event) => {
  const control = event.target.closest("[data-scope][data-key]");
  if (!control) return;
  const target = control.dataset.scope === "global" ? globalSettings : actionSettings;
  target[control.dataset.key] = readValue(control);
  scheduleSave(control.dataset.scope);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-op]");
  if (!button) return;
  button.disabled = true;
  sendToPlugin({ op: button.dataset.op });
  setTimeout(() => { button.disabled = false; }, 900);
});

function renderState(state) {
  const bridgeOk = state.bridge === "running";
  const hooksOk = state.hooks === "installed";
  const label = !bridgeOk ? "BRIDGE " + String(state.bridge || "unknown").toUpperCase()
    : !hooksOk ? "HOOKS " + String(state.hooks || "unknown").toUpperCase()
    : "CONNECTED";
  document.getElementById("connection").textContent = label;
  document.getElementById("connection-dot").className = `dot ${bridgeOk && hooksOk ? "connected" : "setup"}`;
  document.getElementById("hooks-state").textContent = state.hooks || "Unknown";
  document.getElementById("project-count").textContent = String(state.projectCount ?? 0);
  document.getElementById("session-count").textContent = String(state.sessionCount ?? 0);
  document.getElementById("bridge-state").textContent = state.bridgeRunning
    ? `Running · ${state.bridgeAccepted || 0} received · ${state.bridgeSpooled || 0} spooled`
    : "Stopped";
  const summary = state.project
    ? `${state.project.name} · ${state.project.phase} · ${state.project.sessionCount} session(s)`
    : `${state.projectCount || 0} active projects · ${state.sessionCount || 0} sessions`;
  document.getElementById("project-summary").textContent = summary;
  const error = document.getElementById("last-error");
  error.textContent = state.lastError || "";
  error.hidden = !state.lastError;
}
