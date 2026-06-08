import { describe, expect, it } from "vitest";
import { chooseAutoPort } from "../../src/flash/autoPort";
import { defaultConfig } from "../../src/config/nodemcuIni";

describe("chooseAutoPort", () => {
  it("keeps an available configured port", () => {
    const cfg = defaultConfig();
    cfg.nodemcu.port = "COM7";
    const selected = chooseAutoPort([{ path: "COM7" }], cfg);
    expect(selected).toEqual({ port: "COM7", shouldSave: false, reason: "configured-available" });
  });

  it("auto-selects and saves the only detected port when the configured port is missing", () => {
    const cfg = defaultConfig();
    cfg.nodemcu.port = "COM1";
    const selected = chooseAutoPort([{ path: "COM42" }], cfg);
    expect(selected).toEqual({ port: "COM42", shouldSave: true, reason: "single-detected" });
  });

  it("auto-selects one NodeMCU-like port from multiple ports", () => {
    const cfg = defaultConfig();
    const selected = chooseAutoPort([
      { path: "COM1", manufacturer: "Bluetooth" },
      { path: "COM42", manufacturer: "NodeMCU CP210x" },
    ], cfg);
    expect(selected).toEqual({ port: "COM42", shouldSave: true, reason: "single-nodemcu-like" });
  });

  it("does not select ambiguous ports", () => {
    const cfg = defaultConfig();
    const selected = chooseAutoPort([{ path: "COM1" }, { path: "COM2" }], cfg);
    expect(selected).toBeNull();
  });
});
