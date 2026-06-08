import { describe, expect, it } from "vitest";
import { normalizeMacAddress, parseMacAddress } from "../../src/device/deviceIdentity";

describe("device identity helpers", () => {
  it("normalizes colon-separated MAC addresses into UUIDs", () => {
    expect(normalizeMacAddress("AA:BB:CC:DD:EE:FF")).toBe("aabbccddeeff");
  });

  it("rejects malformed MAC addresses", () => {
    expect(normalizeMacAddress("aa:bb")).toBeNull();
  });

  it("parses esptool read_mac output", () => {
    const identity = parseMacAddress("Detecting chip type... ESP8266\nMAC: 5c:cf:7f:12:34:56\n");
    expect(identity).toEqual({
      macAddress: "5c:cf:7f:12:34:56",
      uuid: "5ccf7f123456",
    });
  });
});
