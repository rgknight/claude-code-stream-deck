import { describe, expect, it } from "vitest";

import { openDirectory, openEditor } from "../src/native-launch.js";

describe("native launch validation", () => {
  it("rejects invalid editor launch settings before spawning", async () => {
    await expect(openEditor("", [], process.cwd())).rejects.toThrow(/Invalid editor launch settings/);
    await expect(openEditor("code\0", [], process.cwd())).rejects.toThrow(/Invalid editor launch settings/);
    await expect(openEditor("code", [], "/definitely/not/a/real/dir")).rejects.toThrow();
  });

  it("refuses to open a missing directory", async () => {
    await expect(openDirectory("/definitely/not/a/real/dir")).rejects.toThrow();
  });
});
