import type { NodemcuConfig } from "../config/nodemcuIni";
import type { SerialPort } from "./serialDiscovery";

const NODEMCU_HINTS = ["nodemcu", "esp", "cp210", "ch340", "usb serial", "silicon labs"];

export interface AutoPortSelection {
  port: string;
  shouldSave: boolean;
  reason: "configured-available" | "single-detected" | "single-nodemcu-like";
}

function portMatchesConfigured(port: SerialPort, configured: string): boolean {
  return port.path.toLowerCase() === configured.toLowerCase();
}

export function isNodeMcuLikePort(port: SerialPort): boolean {
  const haystack = [
    port.path,
    port.manufacturer,
    port.productId,
    port.vendorId,
  ].filter(Boolean).join(" ").toLowerCase();
  return NODEMCU_HINTS.some((hint) => haystack.includes(hint));
}

export function chooseAutoPort(
  ports: SerialPort[],
  cfg: NodemcuConfig | null,
  settingsPort = "",
): AutoPortSelection | null {
  const configured = (settingsPort || cfg?.nodemcu.port || "").trim();
  if (configured && ports.some((port) => portMatchesConfigured(port, configured))) {
    return { port: configured, shouldSave: false, reason: "configured-available" };
  }

  if (ports.length === 1) {
    return { port: ports[0].path, shouldSave: !!cfg && ports[0].path !== cfg.nodemcu.port, reason: "single-detected" };
  }

  const nodeMcuLike = ports.filter(isNodeMcuLikePort);
  if (nodeMcuLike.length === 1) {
    return {
      port: nodeMcuLike[0].path,
      shouldSave: !!cfg && nodeMcuLike[0].path !== cfg.nodemcu.port,
      reason: "single-nodemcu-like",
    };
  }

  return null;
}
