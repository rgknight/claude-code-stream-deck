import { describe, expect, it } from "vitest";

import { openDirectory, openEditor } from "../src/native-launch.js";

describe("native launch validation", () => {
  it("rejects invalid editor launch settings before spawning", async () => {
    await expect(openEditor("", [], process.cwd())).rejects.toThrow(/Invalid editor launch settings/);
    await expect(openEditor("code\0", [], process.cwd())).rejects.toThrow(/Invalid editor launch settings/);
    await expect(openEditor("code", [], "/definitely/not/a/real/dir")).rejects.toThrow();
  });

  it("reports an unresolvable editor command instead of failing silently", async () => {
    await expect(openEditor("definitely-not-a-real-editor-xyz", [], process.cwd())).rejects.toThrow(
      /not found on PATH/
    );
  });

  it("refuses to open a missing directory", async () => {
    await expect(openDirectory("/definitely/not/a/real/dir")).rejects.toThrow();
  });
});
