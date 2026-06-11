import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseIni } from "../src/config/nodemcuIni";
import { BuildManager } from "../src/build/buildManager";
import { FlashManager } from "../src/flash/flashManager";
import { Shell } from "../src/util/shell";
import { ToolchainLocator } from "../src/build/toolchain";
import { ensureManagedFirmware } from "../src/firmware/managedFirmware";

async function main(): Promise<void> {
  const cfg = parseIni(fs.readFileSync("nodemcu.ini", "utf-8"));
  const port = process.env.NODEMCU_VSCODE_SERIAL_PORT || cfg.nodemcu.port;
  if (!port) {
    throw new Error("No serial port configured. Set [nodemcu] port in nodemcu.ini or NODEMCU_VSCODE_SERIAL_PORT.");
  }

  const firmwarePath = await ensureManagedFirmware({
    storageRoot: process.env.NODEMCU_VSCODE_STORAGE_ROOT || path.join(os.homedir(), ".nodemcu-vscode"),
    onProgress: (message) => console.log(message),
  });

  const shell = new Shell();
  const toolchain = await new ToolchainLocator(shell).locate();
  console.log(`Building managed firmware at ${firmwarePath}`);
  const build = await new BuildManager(shell).build({
    firmwarePath,
    config: cfg,
    parallel: cfg.build.parallel,
    jobCount: Math.max(1, Math.min(os.cpus().length, 8)),
    verbose: cfg.build.verbose,
    generator: toolchain.generator,
    preferredCmake: toolchain.cmake,
    preferredNinja: toolchain.ninja,
    onLog: (s) => process.stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
  });
  if (!build.success) throw new Error(`Build failed: ${build.summary}`);

  console.log(`Flashing ${port}`);
  const flash = await new FlashManager(shell).flash({
    python: toolchain.python,
    firmwarePath,
    config: cfg,
    port,
    onLog: (s) => process.stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
  });
  if (!flash.success) throw new Error(`Flash failed: exit=${flash.exitCode}`);
  console.log("Done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
