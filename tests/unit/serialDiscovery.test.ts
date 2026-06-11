import { describe, expect, it } from "vitest";
import { serialPortDisplayName } from "../../src/flash/serialDiscovery";

describe("serialPortDisplayName", () => {
  it("prefers the UART bridge chip from a friendly name over the manufacturer", () => {
    expect(serialPortDisplayName({
      path: "COM5",
      manufacturer: "wch.cn",
      friendlyName: "USB-SERIAL CH340 (COM5)",
    })).toBe("CH340");
  });

  it("uses known USB ids when the name is only a vendor", () => {
    expect(serialPortDisplayName({
      path: "COM7",
      manufacturer: "Silicon Labs",
      vendorId: "10C4",
      productId: "EA60",
    })).toBe("CP210x");
  });

  it("detects a known bridge from a Windows PnP id", () => {
    expect(serialPortDisplayName({
      path: "COM9",
      manufacturer: "wch.cn",
      pnpId: "USB\\VID_1A86&PID_7523\\5&1234",
    })).toBe("CH340");
  });

  it("falls back to the friendly name without repeating the port", () => {
    expect(serialPortDisplayName({
      path: "COM8",
      manufacturer: "Acme",
      friendlyName: "Acme Debug Adapter (COM8)",
    })).toBe("Acme Debug Adapter");
  });
});
