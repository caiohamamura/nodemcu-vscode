import { Shell } from "../util/shell";

export interface SerialPort {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
}

export class SerialDiscovery {
  constructor(private shell: Shell) {}

  async list(): Promise<SerialPort[]> {
    const fakePorts = process.env.NODEMCU_VSCODE_FAKE_SERIAL_PORTS;
    if (fakePorts) {
      try {
        const parsed = JSON.parse(fakePorts) as Array<string | SerialPort>;
        return parsed.map((entry) => typeof entry === "string" ? { path: entry } : { ...entry, path: entry.path });
      } catch (error) {
        console.warn("Failed to parse NODEMCU_VSCODE_FAKE_SERIAL_PORTS", error);
      }
    }
    try {
      // Use dynamic import to prevent activation failure if serialport is somehow broken
      const serialport = await import("serialport");
      const ports = await serialport.SerialPort.list();
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || (p as any).friendlyName,
        productId: p.productId,
        vendorId: p.vendorId
      }));
    } catch (e) {
      console.warn("serialport failed, falling back to manual discovery", e);
      if (process.platform === "win32") return this.listWindows();
      return this.listLinux();
    }
  }

  private async listLinux(): Promise<SerialPort[]> {
    const ports: SerialPort[] = [];
    const candidates = await this.globDevices(["/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usbserial*", "/dev/cu.SLAB*", "/dev/cu.usbmodem*"]);
    for (const path of candidates) {
      ports.push({ path });
    }
    return ports;
  }

  private async listWindows(): Promise<SerialPort[]> {
    const r = await this.shell.run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $_.DeviceID -like 'COM*' -or $_.Name -like '*COM*' } | ForEach-Object { $portMatch = $_.Name -match '\\((COM\\d+)\\)'; $port = if ($portMatch) { $Matches[1] } elseif ($_.DeviceID -match '(COM\\d+)') { $Matches[1] } else { $null }; if ($port) { "$port|$($_.Name)" } } | Sort-Object -Unique`,
    ]);
    if (r.exitCode !== 0) {
      const fallback = await this.shell.run("powershell", [
        "-NoProfile",
        "-Command",
        "[System.IO.Ports.SerialPort]::GetPortNames()",
      ]);
      if (fallback.exitCode !== 0) return [];
      return fallback.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && /^COM\d+/i.test(l))
        .map((path) => ({ path }));
    }
    const ports: SerialPort[] = [];
    const seen = new Set<string>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [path, name] = trimmed.split("|", 2);
      if (!path || !/^COM\d+/i.test(path)) continue;
      const key = path.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ path, manufacturer: name || undefined });
    }
    if (ports.length === 0) {
      const fallback = await this.shell.run("powershell", [
        "-NoProfile",
        "-Command",
        "[System.IO.Ports.SerialPort]::GetPortNames()",
      ]);
      if (fallback.exitCode === 0) {
        for (const line of fallback.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || !/^COM\d+/i.test(trimmed)) continue;
          const key = trimmed.toUpperCase();
          if (seen.has(key)) continue;
          seen.add(key);
          ports.push({ path: trimmed });
        }
      }
    }
    return ports;
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
