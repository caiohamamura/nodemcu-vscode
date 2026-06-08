import { describe, expect, it } from "vitest";
import { SerialPort } from "serialport";
import { DirectSerialUploader } from "../../src/upload/directSerialUploader";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
const BAUD_RATE = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "460800");
const RUN_HARDWARE_TEST = process.env.NODEMCU_VSCODE_E2E_DIRECT_SERIAL === "1";

async function availablePortPaths(): Promise<string[]> {
  try {
    const ports = await SerialPort.list();
    return ports.map((port) => port.path);
  } catch {
    return [];
  }
}

const describe_ = RUN_HARDWARE_TEST ? describe : describe.skip;

describe_("E2E DEVICE: direct serial file listing", () => {
  it("lists the two Lua files on the physical device without nodemcu-tool", async () => {
    const paths = await availablePortPaths();
    expect(paths, `serial port ${PORT} was not detected; available ports: ${paths.join(", ") || "(none)"}`).toContain(PORT);

    const logs: string[] = [];
    const uploader = new DirectSerialUploader();
    const result = await uploader.listFiles(
      { python: "python", port: PORT, baud: BAUD_RATE, baudUpload: BAUD_RATE, compile: false },
      (message) => logs.push(message),
    );

    if (!result.success) {
      console.log("=== DIRECT SERIAL LIST LOG ===\n" + logs.join(""));
    }

    expect(result.success, result.error).toBe(true);
    const files = result.files ?? [];
    console.log("Direct serial files:", files);

    const luaFiles = files.filter((file) => file.name.toLowerCase().endsWith(".lua"));
    expect(luaFiles.map((file) => file.name).sort()).toHaveLength(2);
    expect(luaFiles.every((file) => file.size > 0)).toBe(true);
  }, 30_000);
});
