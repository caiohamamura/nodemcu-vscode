import { Shell } from "../util/shell";

export interface SerialPort {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
}

export class SerialDiscovery {
  constructor(private shell: Shell) {}

  async listLinux(): Promise<SerialPort[]> {
    const ports: SerialPort[] = [];
    const candidates = await this.globDevices(["/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usbserial*", "/dev/cu.SLAB*", "/dev/cu.usbmodem*"]);
    for (const path of candidates) {
      ports.push({ path });
    }
    return ports;
  }

  async listWindows(): Promise<SerialPort[]> {
    const r = await this.shell.run("powershell", [
      "-NoProfile",
      "-Command",
      "[System.IO.Ports.SerialPort]::GetPortNames()",
    ]);
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /^COM\d+/i.test(l))
      .map((path) => ({ path }));
  }

  async list(): Promise<SerialPort[]> {
    if (process.platform === "win32") return this.listWindows();
    return this.listLinux();
  }

  private async globDevices(patterns: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const pattern of patterns) {
      const dir = pattern.replace(/[^*?]+$/, "");
      const prefix = pattern.slice(dir.length).replace(/[*?].*$/, "");
      const fs = await import("node:fs/promises");
      try {
        const entries = await fs.readdir(dir);
        for (const e of entries) {
          if (e.startsWith(prefix)) out.push(dir + e);
        }
      } catch {
        // dir doesn't exist
      }
    }
    return out;
  }
}
