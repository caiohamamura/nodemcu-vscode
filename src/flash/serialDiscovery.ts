import { Shell } from "../util/shell";

export interface SerialPort {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  productId?: string;
  vendorId?: string;
  pnpId?: string;
  serialNumber?: string;
  locationId?: string;
}

type SerialPortListEntry = SerialPort & {
  friendlyName?: string;
};

const BRIDGE_ID_NAMES: Record<string, string> = {
  "10c4:ea60": "CP210x",
  "10c4:ea70": "CP2105",
  "10c4:ea71": "CP2108",
  "1a86:5523": "CH341",
  "1a86:7523": "CH340",
  "0403:6001": "FT232",
  "0403:6015": "FT231X",
  "067b:2303": "PL2303",
};

const BRIDGE_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\bCP210X\b/i, "CP210x"],
  [/\bCP210\d+[A-Z]?\b/i, "$&"],
  [/\bCH34[01][A-Z]?\b/i, "$&"],
  [/\bFT23[012]X?\b/i, "$&"],
  [/\bFT232R?\b/i, "$&"],
  [/\bPL2303[A-Z]?\b/i, "$&"],
];

function cleanDisplayName(name: string, path: string): string {
  return name
    .replace(new RegExp(`\\s*\\(${escapeRegExp(path)}\\)\\s*`, "ig"), " ")
    .replace(new RegExp(`\\b${escapeRegExp(path)}\\b`, "ig"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUsbId(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^0x/, "");
}

function bridgeNameFromIds(vendorId: string | undefined, productId: string | undefined): string {
  return BRIDGE_ID_NAMES[`${normalizeUsbId(vendorId)}:${normalizeUsbId(productId)}`] ?? "";
}

function detectBridgeName(port: SerialPort): string {
  const idName = bridgeNameFromIds(port.vendorId, port.productId);
  if (idName) return idName;

  const pnpIds = port.pnpId?.match(/VID_([0-9A-F]{4}).*PID_([0-9A-F]{4})/i);
  const pnpIdName = pnpIds ? bridgeNameFromIds(pnpIds[1], pnpIds[2]) : "";
  if (pnpIdName) return pnpIdName;

  const haystack = [
    port.friendlyName,
    port.manufacturer,
    port.pnpId,
    port.path,
  ].filter(Boolean).join(" ");
  for (const [pattern, replacement] of BRIDGE_NAME_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) return replacement === "$&" ? match[0].toUpperCase().replace("CP210X", "CP210x") : replacement;
  }
  return "";
}

export function serialPortDisplayName(port: SerialPort): string {
  const bridgeName = detectBridgeName(port);
  if (bridgeName) return bridgeName;
  return cleanDisplayName(port.friendlyName || port.manufacturer || "", port.path);
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
      const ports = await serialport.SerialPort.list() as SerialPortListEntry[];
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer,
        friendlyName: p.friendlyName,
        productId: p.productId,
        vendorId: p.vendorId,
        pnpId: p.pnpId,
        serialNumber: p.serialNumber,
        locationId: p.locationId,
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
      ports.push({ path, manufacturer: name || undefined, friendlyName: name || undefined });
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
