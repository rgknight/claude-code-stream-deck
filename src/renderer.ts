import type { BridgeState, HooksStatus, ProjectState } from "./domain.js";
import { deriveDisplayState, formatAge } from "./status.js";

export type UtilityIcon = "health" | "warning" | "hold";

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
    return entities[character] ?? "";
  });
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function splitProjectName(name: string, width = 15): [string, string] {
  const clean = name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
  if (clean.length <= width) return [clean, ""];
  const candidate = clean.slice(0, width + 1);
  const breakAt = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("-"), candidate.lastIndexOf("_"));
  const firstEnd = breakAt >= 4 ? breakAt : width;
  const first = clean.slice(0, firstEnd).trim();
  const rest = clean.slice(firstEnd).replace(/^[-_\s]+/, "");
  const second = rest.length > width ? `${rest.slice(0, width - 1)}…` : rest;
  return [first, second];
}

export interface RenderOptions {
  project?: ProjectState | undefined;
  bridge: BridgeState;
  hooks: HooksStatus;
  freshMinutes: number;
  staleMinutes: number;
  pinned?: boolean;
  showFreshness?: boolean;
  showAttentionCount?: boolean;
  displayNameOverride?: string;
  now?: number;
}

function statusIcon(label: string, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
  switch (label) {
    case "DONE":
      return `<path d="m20 27 6 6 12-14" ${stroke}/>`;
    case "WORKING":
    case "ACTIVE?":
      return `<path d="m23 18 16 9-16 9z" fill="${color}"/>`;
    case "FAILED":
    case "BRIDGE":
      return `<path d="m20 19 18 17m0-17L20 36" ${stroke}/>`;
    case "APPROVAL":
    case "INPUT":
    case "SETUP":
      return `<path d="M29 18v12" ${stroke}/><circle cx="29" cy="36" r="2.5" fill="${color}"/>`;
    case "IDLE":
      return `<path d="M23 19v16m12-16v16" ${stroke}/>`;
    default:
      return `<circle cx="29" cy="27" r="9" ${stroke}/><circle cx="29" cy="27" r="2.5" fill="${color}"/>`;
  }
}

function utilityIconSvg(icon: UtilityIcon, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  switch (icon) {
    case "health":
      return `<circle cx="72" cy="57" r="31" ${stroke}/><path d="m53 58 13 13 27-29" ${stroke}/>`;
    case "hold":
      return `<circle cx="72" cy="57" r="34" ${stroke}/><rect x="57" y="42" width="30" height="30" rx="5" fill="${color}"/>`;
    case "warning":
      return `<path d="m72 25 40 66H32z" ${stroke}/><path d="M72 47v20" ${stroke}/><circle cx="72" cy="78" r="3.5" fill="${color}"/>`;
  }
}

export function renderProjectSvg(options: RenderOptions): string {
  const now = options.now ?? Date.now();
  const display = deriveDisplayState(options.project, options.bridge, options.hooks, options.freshMinutes, options.staleMinutes, now);
  const projectName = options.displayNameOverride || options.project?.displayName || "Claude";
  const [line1, line2] = splitProjectName(projectName);
  const attention = options.project?.attentionCount ?? 0;
  const count = options.showAttentionCount !== false && attention > 1 ? String(Math.min(99, attention)) : "";
  const age = options.showFreshness === false ? "" : formatAge(options.project?.recencyAt, now);
  const footer = !options.project ? "EMPTY SLOT" : age ? `UPDATED ${age.toUpperCase()}` : "";
  const pin = options.pinned
    ? `<path d="M116 5h22v22z" fill="${display.color}"/><circle cx="128" cy="15" r="3" fill="#080B12"/>`
    : "";
  const attentionBadge = count
    ? `<circle cx="120" cy="27" r="14" fill="#F43F5E" stroke="#FFFFFF" stroke-width="2"/><text x="120" y="32" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="800" fill="#FFFFFF">${count}</text>`
    : "";
  // Solid states fill the whole key with a bright color so they read at a
  // glance on small decks; text and accents switch to the dark ink color.
  const bodyFill = display.solid ? display.background : "url(#bg)";
  const nameFill = display.solid ? display.color : "#FFFFFF";
  const footerFill = display.solid ? display.color : "#E7ECF4";
  const pillOpacity = display.solid ? ".14" : ".11";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${display.background}"/>
      <stop offset=".58" stop-color="#0B101A"/>
      <stop offset="1" stop-color="#07090E"/>
    </linearGradient>
  </defs>
  <rect width="144" height="144" rx="19" fill="#05070B"/>
  <rect x="3" y="3" width="138" height="138" rx="17" fill="${bodyFill}" stroke="${display.color}" stroke-opacity=".34" stroke-width="2"/>
  <rect x="8" y="11" width="96" height="32" rx="16" fill="${display.color}" opacity="${pillOpacity}"/>
  ${statusIcon(display.label, display.color)}
  <text x="48" y="32" font-family="Arial, sans-serif" font-size="11" font-weight="800" letter-spacing=".6" fill="${display.color}">${escapeXml(display.label.slice(0, 10))}</text>
  ${pin}
  ${attentionBadge}
  <text x="72" y="78" text-anchor="middle" font-family="Arial, sans-serif" font-size="15.5" font-weight="700" fill="${nameFill}">${escapeXml(line1)}</text>
  <text x="72" y="99" text-anchor="middle" font-family="Arial, sans-serif" font-size="15.5" font-weight="700" fill="${nameFill}">${escapeXml(line2)}</text>
  <text x="72" y="126" text-anchor="middle" font-family="Arial, sans-serif" font-size="${footer.length > 14 ? "11.5" : "13"}" font-weight="800" letter-spacing=".35" fill="${footerFill}">${escapeXml(footer)}</text>
  <rect x="5" y="135" width="134" height="4" rx="2" fill="${display.color}"/>
</svg>`;
}

export function renderUtilitySvg(
  label: string,
  icon: UtilityIcon,
  color = "#67E8F9",
  background = "#0B1D2A",
  solid = false
): string {
  const safeLabel = label.toUpperCase().slice(0, 12);
  const bodyFill = solid ? background : "url(#utility-bg)";
  const labelFill = solid ? color : "#FFFFFF";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="utility-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${background}"/>
      <stop offset=".65" stop-color="#0A0E16"/>
      <stop offset="1" stop-color="#06080C"/>
    </linearGradient>
  </defs>
  <rect width="144" height="144" rx="19" fill="#05070B"/>
  <rect x="3" y="3" width="138" height="138" rx="17" fill="${bodyFill}" stroke="${color}" stroke-opacity=".35" stroke-width="2"/>
  <rect x="20" y="15" width="104" height="84" rx="23" fill="${color}" opacity="${solid ? ".12" : ".08"}"/>
  ${utilityIconSvg(icon, color)}
  <text x="72" y="122" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="800" letter-spacing=".7" fill="${labelFill}">${escapeXml(safeLabel)}</text>
  <rect x="39" y="134" width="66" height="4" rx="2" fill="${color}"/>
</svg>`;
}
