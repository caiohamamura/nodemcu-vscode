import { parseIni } from "../src/config/nodemcuIni";
import { BuildManager } from "../src/build/buildManager";
import { FlashManager } from "../src/flash/flashManager";
import { Shell } from "../src/util/shell";
import { ToolchainLocator } from "../src/build/toolchain";
import * as fs from "fs";

async function main() {
  const cfg = parseIni(fs.readFileSync("nodemcu.ini", "utf-8"));
  const shell = new Shell();
  const toolchain = await new ToolchainLocator(shell).locate();
  const bm = new BuildManager(shell);
  console.log("Building...");
  const res = await bm.build({
    firmwarePath: "C:/Users/caioh/src/nodemcu-firmware",
    config: cfg,
    parallel: true,
    jobCount: 4,
    verbose: false,
    generator: toolchain.generator,
    onLog: (s) => process.stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
  });
  if (!res.success) throw new Error("Build failed");
  
  console.log("Flashing...");
  const fm = new FlashManager(shell);
  const fres = await fm.flash({
    python: "python",
    firmwarePath: "C:/Users/caioh/src/nodemcu-firmware",
    config: cfg,
    port: "COM7",
    onLog: (s) => process.stdout.write(s),
    onStderr: (s) => process.stderr.write(s),
  });
  if (!fres.success) throw new Error("Flash failed");
  console.log("Done");
}
main().catch(console.error);
