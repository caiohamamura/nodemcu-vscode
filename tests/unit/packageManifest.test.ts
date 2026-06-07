import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

describe("package manifest", () => {
  it("does not hard-block activation on optional language tooling", () => {
    expect(manifest).not.toHaveProperty("extensionDependencies");
    expect(manifest.extensionPack).toContain("sumneko.lua");
  });
});
