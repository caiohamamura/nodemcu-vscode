import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ensureManagedFirmware, MANAGED_FIRMWARE_TAG } from "../../src/firmware/managedFirmware";

describe("ensureManagedFirmware", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-managed-fw-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createExtractedFirmwareRoot(options: { marker?: boolean; omitSubmodule?: "u8g2" | "ucg" | "snprintf" } = {}): string {
    const root = path.join(tmp, "firmware", MANAGED_FIRMWARE_TAG);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "CMakeLists.txt"), "# fake cmake");
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "app", "CMakeLists.txt"), "add_executable(${EXECUTABLE_NAME} dummy.c)\n");
    fs.mkdirSync(path.join(root, "tools", "luac_cross"), { recursive: true });
    fs.writeFileSync(path.join(root, "tools", "luac_cross", "CMakeLists.txt"), "set(SOURCES\n    ${APP_DIR}/modules/pixbuf.c\n)\n");

    // Pre-create the toolchain bin dir so preExtractToolchain skips the download in all cases.
    fs.mkdirSync(path.join(root, "tools", "toolchains", "esp8266-xtensa-lx106-elf-win32-1.22.0-88-gde0bdc1-4.8.5", "bin"), { recursive: true });

    if (options.omitSubmodule !== "snprintf") {
      fs.mkdirSync(path.join(root, "app", "libc", "c99-snprintf"), { recursive: true });
      fs.writeFileSync(path.join(root, "app", "libc", "c99-snprintf", "snprintf.c"), "// fake snprintf");
    }
    if (options.omitSubmodule !== "u8g2") {
      fs.mkdirSync(path.join(root, "app", "u8g2lib", "u8g2", "src", "clib"), { recursive: true });
      fs.writeFileSync(path.join(root, "app", "u8g2lib", "u8g2", "src", "clib", "u8g2.h"), "// fake u8g2.h");
    }
    if (options.omitSubmodule !== "ucg") {
      fs.mkdirSync(path.join(root, "app", "ucglib", "ucg", "src", "clib"), { recursive: true });
      fs.writeFileSync(path.join(root, "app", "ucglib", "ucg", "src", "clib", "ucg.h"), "// fake ucg.h");
    }


    if (options.marker) {
      fs.writeFileSync(path.join(root, ".nodemcu-vscode-managed-firmware.json"), JSON.stringify({ tag: MANAGED_FIRMWARE_TAG, url: "http://example.com" }));
    }
    return root;
  }

  it("does not redownload or re-extract if firmware is already valid", async () => {
    const root = createExtractedFirmwareRoot({ marker: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const returnedPath = await ensureManagedFirmware({ storageRoot: tmp });

    expect(returnedPath).toBe(root);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not redownload if firmware was already extracted with u8g2 and ucg but has no marker yet", async () => {
    const root = createExtractedFirmwareRoot();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const returnedPath = await ensureManagedFirmware({ storageRoot: tmp });

    expect(returnedPath).toBe(root);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".nodemcu-vscode-managed-firmware.json"))).toBe(true);
  });

  it("triggers redownload if u8g2 submodule is missing", async () => {
    createExtractedFirmwareRoot({ marker: true, omitSubmodule: "u8g2" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Triggered download");
    });

    await expect(ensureManagedFirmware({ storageRoot: tmp })).rejects.toThrow("Triggered download");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("triggers redownload if ucg submodule is missing", async () => {
    createExtractedFirmwareRoot({ marker: true, omitSubmodule: "ucg" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Triggered download");
    });

    await expect(ensureManagedFirmware({ storageRoot: tmp })).rejects.toThrow("Triggered download");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
