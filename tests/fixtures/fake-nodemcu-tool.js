#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const stateDir = process.env.NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE || path.join(require("node:os").tmpdir(), "nodemcu-fake-state");
fs.mkdirSync(stateDir, { recursive: true });

function remotePath(name) {
  const safe = String(name || "").replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\/+/, "");
  return path.join(stateDir, safe);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function commandName() {
  const known = ["upload", "download", "remove", "fsinfo", "reset", "mkfs", "run"];
  return process.argv.find((arg) => known.includes(arg));
}

const command = commandName();

if (process.argv.includes("--version")) {
  console.log("fake-nodemcu-tool 1.0.0");
  process.exit(0);
}

if (command === "upload") {
  const remote = argValue("--remotename", path.basename(process.argv[process.argv.length - 1]));
  const local = process.argv[process.argv.length - 1];
  fs.mkdirSync(path.dirname(remotePath(remote)), { recursive: true });
  fs.copyFileSync(local, remotePath(remote));
  console.log(`Uploading "${local}" >> "${remote}"...`);
  console.log("File Transfer complete!");
  process.exit(0);
}

if (command === "download") {
  const remote = process.argv[process.argv.indexOf("download") + 1];
  const data = fs.existsSync(remotePath(remote)) ? fs.readFileSync(remotePath(remote)) : Buffer.alloc(0);
  fs.writeFileSync(path.basename(remote), data);
  console.log("Data Transfer complete!");
  process.exit(0);
}

if (command === "remove") {
  const remote = process.argv[process.argv.indexOf("remove") + 1];
  fs.rmSync(remotePath(remote), { force: true });
  console.log(`File "${remote}" removed!`);
  process.exit(0);
}

if (command === "fsinfo") {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const name = path.relative(stateDir, fullPath).replace(/\\/g, "/");
        files.push({ name, size: fs.statSync(fullPath).size });
      }
    }
  };
  walk(stateDir);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files, meta: { remaining: 1000, total: 1000 } }));
  } else {
    for (const file of files) console.log(`${file.name} ${file.size}`);
  }
  process.exit(0);
}

if (command === "mkfs") {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  console.log("File System created");
  process.exit(0);
}

if (command === "reset" || command === "run") {
  console.log("OK");
  process.exit(0);
}

console.error(`Unknown fake nodemcu-tool command: ${process.argv.slice(2).join(" ")}`);
process.exit(1);
