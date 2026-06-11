import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SerialPort } from "serialport";
import { parseIni } from "../src/config/nodemcuIni";
import { BuildManager } from "../src/build/buildManager";
import { ToolchainLocator } from "../src/build/toolchain";
import { FlashManager } from "../src/flash/flashManager";
import { ensureManagedFirmware } from "../src/firmware/managedFirmware";
import { Shell } from "../src/util/shell";
import { DirectSerialUploader } from "../src/upload/directSerialUploader";

const storageRoot = process.env.NODEMCU_VSCODE_STORAGE_ROOT || path.join(os.homedir(), ".nodemcu-vscode");

let firmwarePath = path.join(
  storageRoot,
  "firmware",
  "mbedtls-2.28.10-beta",
);

function run(command: string, args: string[], timeoutMs = 60_000): childProcess.SpawnSyncReturns<string> {
  const result = childProcess.spawnSync(command, args, { encoding: "utf-8", timeout: timeoutMs });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result;
}

function cleanBuildOutputs(): void {
  for (const target of [
    path.join(firmwarePath, "build"),
    path.join(firmwarePath, "bin", "0x00000.bin"),
    path.join(firmwarePath, "bin", "0x10000.bin"),
  ]) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

async function probeLuaPrompt(portPath: string, baudRate: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    const timeout = setTimeout(() => {
      port.close(() => reject(new Error("Timed out waiting for NodeMCU Lua prompt.")));
    }, 8_000);

    port.on("data", (chunk: Buffer) => {
      output += chunk.toString("latin1");
      if (/>[\s\r\n]*$/.test(output) && /NodeMCU|Lua|node\.info/.test(output)) {
        clearTimeout(timeout);
        port.close(() => resolve(output));
      }
    });
    port.open(async (err) => {
      if (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      try {
        await port.set({ dtr: false, rts: true });
        await new Promise((r) => setTimeout(r, 150));
        await port.set({ dtr: false, rts: false });
        await new Promise((r) => setTimeout(r, 2500));
        port.write("\r\nprint(node.info())\r\n");
      } catch (error) {
        clearTimeout(timeout);
        port.close(() => reject(error));
      }
    });
  });
}

async function main(): Promise<void> {
  firmwarePath = await ensureManagedFirmware({
    storageRoot,
    onProgress: (message) => console.log(message),
  });

  const cfg = parseIni(fs.readFileSync("nodemcu.ini", "utf-8"));
  const port = process.env.NODEMCU_VSCODE_SERIAL_PORT || cfg.nodemcu.port;
  if (!port) {
    throw new Error("No serial port configured. Set [nodemcu] port in nodemcu.ini or NODEMCU_VSCODE_SERIAL_PORT.");
  }
  console.log(JSON.stringify({ firmwarePath, port, modules: cfg.c_modules }, null, 2));

  console.log("\n== Pre-flash ESP8266 probe ==");
  const probe = run("python", ["-m", "esptool", "--port", port, "--baud", String(cfg.nodemcu.baud), "chip-id"], 60_000);
  if (probe.status !== 0 || !/ESP8266/i.test((probe.stdout ?? "") + (probe.stderr ?? ""))) {
    throw new Error(`${port} did not respond as ESP8266 before flashing; exit=${probe.status}`);
  }

  console.log("\n== Clean build ==");
  cleanBuildOutputs();
  const shell = new Shell();
  const toolchain = await new ToolchainLocator(shell).locate();
  console.log(`Generator: ${toolchain.generator}`);

  let buildLog = "";
  let buildErr = "";
  const build = await new BuildManager(shell).build({
    firmwarePath,
    config: cfg,
    parallel: true,
    jobCount: Math.min(os.cpus().length, 8),
    verbose: false,
    generator: toolchain.generator,
    onLog: (s) => {
      buildLog += s;
      process.stdout.write(s);
    },
    onStderr: (s) => {
      buildErr += s;
      process.stderr.write(s);
    },
  });
  console.log("\nBUILD_RESULT=" + JSON.stringify(build, null, 2));
  if (!build.success) {
    console.error("\nLAST_BUILD_LOG=" + buildLog.slice(-12000));
    console.error("\nLAST_BUILD_ERR=" + buildErr.slice(-12000));
    throw new Error(`Build failed: ${build.summary}`);
  }
  for (const [name, file] of Object.entries(build.binPaths)) {
    const stat = fs.statSync(file);
    console.log(`${name}: ${file} (${stat.size} bytes)`);
  }

  console.log(`\n== Flash ${port} ==`);
  let flashOut = "";
  let flashErr = "";
  const flash = await new FlashManager(shell).flash({
    python: "python",
    firmwarePath,
    config: cfg,
    port,
    onLog: (s) => {
      flashOut += s;
      process.stdout.write(s);
    },
    onStderr: (s) => {
      flashErr += s;
      process.stderr.write(s);
    },
  });
  console.log("\nFLASH_RESULT=" + JSON.stringify(flash, null, 2));
  if (!flash.success) {
    console.error("\nFLASH_STDOUT=" + flashOut);
    console.error("\nFLASH_STDERR=" + flashErr);
    throw new Error(`Flash failed: exit=${flash.exitCode}`);
  }

  console.log("\n== Post-flash ESP8266 probe ==");
  const postProbe = run("python", ["-m", "esptool", "--port", port, "--baud", String(cfg.nodemcu.baud), "chip-id"], 60_000);
  if (postProbe.status !== 0) {
    throw new Error(`${port} did not respond after flashing; exit=${postProbe.status}`);
  }

  console.log("\n== Lua prompt probe ==");
  const luaOutput = await probeLuaPrompt(port, cfg.nodemcu.baud);
  console.log(luaOutput);

  console.log("\n== NodeMCU file-system probe ==");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const tool = new DirectSerialUploader();
  const files = await tool.listFiles(
    { python: "python", port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
    (s) => process.stdout.write(s),
  );
  if (!files.success) {
    throw new Error(`File-system probe failed: ${files.error}`);
  }
  console.log("FILES=" + JSON.stringify(files.files, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
