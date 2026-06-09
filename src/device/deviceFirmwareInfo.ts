import { SerialPort } from "serialport";

export interface DeviceFirmwareInfo {
  /** Firmware version parsed from the boot banner, e.g. "3.0.0.0". */
  version: string | null;
  /** C modules the running firmware reports in its boot banner. */
  modules: string[];
}

/**
 * Best-effort read of what the physically attached device is running. Resets the
 * board (DTR/RTS pulse) so NodeMCU prints its boot banner, then parses the
 * `modules: a;b;c` and `NodeMCU <version>` lines. Never throws and resolves
 * `null` if the banner can't be read (port busy, not NodeMCU, timeout) — callers
 * treat it as informational only.
 */
export async function readDeviceFirmwareInfo(opts: {
  port: string;
  baud: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DeviceFirmwareInfo | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return await new Promise<DeviceFirmwareInfo | null>((resolve) => {
    let settled = false;
    let buffer = "";
    let sp: SerialPort | null = null;

    const parse = (): DeviceFirmwareInfo | null => {
      // Require the modules line to be newline-terminated so we don't capture a
      // partial list while the banner is still streaming in.
      const modMatch = /modules:\s*([^\r\n]+)[\r\n]/i.exec(buffer);
      if (!modMatch) return null;
      const verMatch = /NodeMCU\s+([0-9][0-9.]*)/i.exec(buffer);
      const modules = modMatch[1]
        .split(/[;,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { version: verMatch ? verMatch[1] : null, modules };
    };

    const finish = (result: DeviceFirmwareInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        if (sp && sp.isOpen) sp.close(() => undefined);
      } catch {
        /* ignore close errors */
      }
      resolve(result);
    };

    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(parse()), timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      sp = new SerialPort({ path: opts.port, baudRate: opts.baud, autoOpen: false });
    } catch {
      finish(null);
      return;
    }
    sp.on("error", () => finish(null));
    sp.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const parsed = parse();
      if (parsed) finish(parsed);
    });
    sp.open((err) => {
      if (err) {
        finish(null);
        return;
      }
      // Pulse DTR/RTS to reset the board so it reprints its boot banner.
      try {
        sp!.set({ dtr: false, rts: true }, () => {
          setTimeout(() => {
            sp!.set({ dtr: false, rts: false }, () => undefined);
          }, 100);
        });
      } catch {
        /* device may auto-print anyway */
      }
    });
  });
}
