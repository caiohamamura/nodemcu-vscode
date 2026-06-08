import { Shell } from "../util/shell";

export interface DeviceIdentity {
  macAddress: string;
  uuid: string;
}

export function normalizeMacAddress(value: string): string | null {
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex : null;
}

export function parseMacAddress(output: string): DeviceIdentity | null {
  const macPattern = /\b([0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{12})\b/i;
  const match = output.match(macPattern);
  if (!match) return null;
  const uuid = normalizeMacAddress(match[1]);
  if (!uuid) return null;
  const macAddress = uuid.match(/.{1,2}/g)?.join(":") ?? uuid;
  return { macAddress, uuid };
}

export async function readDeviceIdentity(opts: {
  shell: Shell;
  python: string;
  port: string;
  baud: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ success: boolean; identity?: DeviceIdentity; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const abortFromCaller = () => controller.abort();
  opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let result;
  try {
    result = await opts.shell.run(
      opts.python,
      ["-m", "esptool", "--port", opts.port, "--baud", String(opts.baud), "read-mac"],
      { signal: controller.signal },
    );
  } catch (error) {
    const message = controller.signal.aborted
      ? "Timed out reading device MAC address"
      : error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr || result.stdout || "Unable to read device MAC address" };
  }
  const identity = parseMacAddress(combined);
  return identity
    ? { success: true, identity }
    : { success: false, error: "Unable to parse device MAC address from esptool output" };
}
