import { SerialCursor } from "./serialCursor";
import { SerialSession } from "./serialSession";

export const SERIAL_PATTERNS = {
  luaPrompt: /(^|[\r\n])>\s*$|>\s*$/m,
  bootBanner: /NodeMCU/i,
  bootMode: /boot mode:/i,
  resetCause: /rst cause:/i,
  panic: /PANIC|Fatal exception|wdt reset/i,
  vscodeBegin: /__VSCODE_BEGIN_[A-Fa-f0-9]+__/,
  vscodeEnd: /__VSCODE_END_[A-Fa-f0-9]+__/,
};

export type SerialDeviceEvent =
  | { type: "boot-start"; text: string }
  | { type: "boot-ready"; text: string }
  | { type: "lua-prompt"; text: string }
  | { type: "vscode-marker"; marker: "begin" | "end"; text: string }
  | { type: "panic"; text: string };

export async function waitForLuaPrompt(
  session: SerialSession,
  cursor: SerialCursor,
  timeoutMs = 6_000,
): Promise<void> {
  await session.write("\r\n");
  await cursor.waitFor(SERIAL_PATTERNS.luaPrompt, { timeoutMs });
}

export async function waitForBoot(
  _session: SerialSession,
  cursor: SerialCursor,
  timeoutMs = 10_000,
): Promise<void> {
  await cursor.waitForAny(
    [SERIAL_PATTERNS.bootBanner, SERIAL_PATTERNS.bootMode, SERIAL_PATTERNS.luaPrompt],
    { timeoutMs },
  );
}
