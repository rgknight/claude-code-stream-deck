import { describe, expect, it } from "vitest";

import type { ProjectState } from "../src/domain.js";
import { escapeXml, renderProjectSvg, renderUtilitySvg, splitProjectName, svgDataUrl } from "../src/renderer.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function project(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "sha256:abc",
    projectRoot: "/repo/dashboard",
    identityAnchor: "/repo/dashboard",
    displayName: "dashboard",
    sessions: [],
    primarySessionId: "session-1",
    phase: "needs_input",
    stale: false,
    attentionCount: 1,
    recencyAt: NOW - 20 * 60_000,
    ...overrides
  };
}

describe("key renderer", () => {
  it("escapes hostile SVG content", () => {
    const hostile = '<script>alert("x")</script>&';
    expect(escapeXml(hostile)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
    const svg = renderProjectSvg({
      bridge: "running",
      hooks: "installed",
      freshMinutes: 15,
      staleMinutes: 120,
      displayNameOverride: hostile
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("constrains project names to two short lines", () => {
    const [first, second] = splitProjectName("an-extremely-long-project-name");
    expect(first.length).toBeLessThanOrEqual(15);
    expect(second.length).toBeLessThanOrEqual(15);
  });

  it("encodes generated SVG as a Stream Deck image data URL", () => {
    const svg = renderUtilitySvg("Health", "health");
    const url = svgDataUrl(svg);
    expect(url).toMatch(/^data:image\/svg\+xml,/);
    expect(url).toContain("%3Csvg");
    expect(decodeURIComponent(url.slice("data:image/svg+xml,".length))).toBe(svg);
  });

  it("renders session state and age directly into the key artwork", () => {
    const svg = renderProjectSvg({
      bridge: "running",
      hooks: "installed",
      freshMinutes: 15,
      staleMinutes: 120,
      project: project(),
      now: NOW
    });
    expect(svg).toContain("INPUT");
    expect(svg).toContain("dashboard");
    expect(svg).toContain("UPDATED 20M");
  });

  it("labels empty slots", () => {
    const svg = renderProjectSvg({
      bridge: "running",
      hooks: "installed",
      freshMinutes: 15,
      staleMinutes: 120,
      now: NOW
    });
    expect(svg).toContain("NO SESSION");
    expect(svg).toContain("EMPTY SLOT");
  });

  it("shows an attention badge only when more than one session is waiting", () => {
    const single = renderProjectSvg({
      bridge: "running",
      hooks: "installed",
      freshMinutes: 15,
      staleMinutes: 120,
      project: project({ attentionCount: 1 }),
      now: NOW
    });
    expect(single).not.toContain("#F43F5E");
    const multiple = renderProjectSvg({
      bridge: "running",
      hooks: "installed",
      freshMinutes: 15,
      staleMinutes: 120,
      project: project({ attentionCount: 3 }),
      now: NOW
    });
    expect(multiple).toContain("#F43F5E");
  });
});
