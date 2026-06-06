import { describe, it, expect } from "vitest";
import { generateLuaApiFile, generateLuaRc } from "../../src/luaApi/apiFiles";

describe("generateLuaApiFile", () => {
  it("emits @meta, NodeMCUModule class, and one entry per enabled module", () => {
    const r = generateLuaApiFile({
      modules: ["wifi", "node", "mqtt"],
      outputPath: "/tmp/test-api.lua",
    });
    const content = require("node:fs").readFileSync(r, "utf-8");
    expect(content).toContain("---@meta");
    expect(content).toContain("---@class NodeMCUModule");
    expect(content).toContain("wifi = wifi or {}");
    expect(content).toContain("node = node or {}");
    expect(content).toContain("mqtt = mqtt or {}");
  });

  it("deduplicates and sorts module names", () => {
    const r = generateLuaApiFile({
      modules: ["mqtt", "wifi", "wifi", "adc"],
      outputPath: "/tmp/test-api2.lua",
    });
    const content = require("node:fs").readFileSync(r, "utf-8");
    const wifiIdx = content.indexOf("wifi =");
    const adcIdx = content.indexOf("adc =");
    const mqttIdx = content.indexOf("mqtt =");
    expect(adcIdx).toBeLessThan(mqttIdx);
    expect(mqttIdx).toBeLessThan(wifiIdx);
  });
});

describe("generateLuaRc", () => {
  it("emits a valid LuaRC json with library paths and runtime path", () => {
    const json = generateLuaRc({
      workspaceRoot: "/proj",
      luaModulesDirs: ["/fw/lua_modules", "/proj/lua"],
      apiFile: "/proj/.vscode/nodemcu-api.lua",
    });
    const parsed = JSON.parse(json);
    expect(parsed.runtime.path).toBe("/fw/lua_modules;/proj/lua");
    expect(parsed.workspace.library).toBe("/fw/lua_modules;/proj/lua");
    expect(parsed.diagnostics.globals).toContain("node");
    expect(parsed.diagnostics.globals).toContain("wifi");
  });
});
