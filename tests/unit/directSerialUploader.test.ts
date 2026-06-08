import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DirectSerialUploader, validateRemoteName, type SerialUploadTransport } from "../../src/upload/directSerialUploader";

class FakeTransport implements SerialUploadTransport {
  writes: Array<string | Buffer> = [];
  sets: Array<{ dtr?: boolean; rts?: boolean }> = [];
  opened = false;
  closed = false;

  constructor(private prompts: string[] = []) {}

  async open(): Promise<void> {
    this.opened = true;
  }

  async write(data: string | Buffer): Promise<void> {
    this.writes.push(data);
  }

  async waitForPrompt(): Promise<string> {
    return this.prompts.shift() ?? "\r\n>";
  }

  async set(options: { dtr?: boolean; rts?: boolean }): Promise<void> {
    this.sets.push(options);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const tempDirs: string[] = [];

function tempFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-uploader-"));
  tempDirs.push(dir);
  const file = path.join(dir, "init.lua");
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DirectSerialUploader", () => {
  it("writes a temp file before replacing init.lua", async () => {
    const transport = new FakeTransport();
    const uploader = new DirectSerialUploader(() => transport);
    const localPath = tempFile("print('hello')\n");

    const result = await uploader.upload(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      localPath,
      "init.lua",
      () => {},
    );

    expect(result.success).toBe(true);
    const commands = transport.writes.map((w) => w.toString());
    expect(commands).toContain("file.remove(\".__nodemcu_upload_tmp\")\r\n");
    expect(commands).toContain("assert(file.open(\".__nodemcu_upload_tmp\",\"w+\"))\r\n");
    expect(commands.some((cmd) => cmd.startsWith("__vscode_hex("))).toBe(true);
    expect(commands).toContain("file.remove(\"init.lua\")\r\n");
    expect(commands).toContain("assert(file.rename(\".__nodemcu_upload_tmp\",\"init.lua\"))\r\n");
    expect(transport.closed).toBe(true);
  });

  it("compiles uploaded Lua when compile is requested", async () => {
    const transport = new FakeTransport();
    const uploader = new DirectSerialUploader(() => transport);
    const localPath = tempFile("return {}\n");

    const result = await uploader.upload(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: true },
      localPath,
      "module.lua",
      () => {},
    );

    expect(result.success).toBe(true);
    const commands = transport.writes.map((w) => w.toString());
    expect(commands).toContain("node.compile(\"module.lua\")\r\n");
    expect(commands.filter((cmd) => cmd === "file.remove(\"module.lua\")\r\n")).toHaveLength(2);
    expect(commands).toContain("file.remove(\"module.lc\")\r\n");
  });

  it("uploads .lc requests as Lua source before compiling on the device", async () => {
    const transport = new FakeTransport();
    const uploader = new DirectSerialUploader(() => transport);
    const localPath = tempFile("return {}\n");

    const result = await uploader.upload(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: true },
      localPath,
      "bh1750.lc",
      () => {},
    );

    expect(result.success).toBe(true);
    const commands = transport.writes.map((w) => w.toString());
    expect(commands).toContain("file.remove(\"bh1750.lua\")\r\n");
    expect(commands).toContain("file.remove(\"bh1750.lc\")\r\n");
    expect(commands).toContain("assert(file.rename(\".__nodemcu_upload_tmp\",\"bh1750.lua\"))\r\n");
    expect(commands).toContain("node.compile(\"bh1750.lua\")\r\n");
    expect(commands.filter((cmd) => cmd === "file.remove(\"bh1750.lua\")\r\n")).toHaveLength(2);
  });

  it("downloads file content over direct serial", async () => {
    const payload = Buffer.from("print('hi')\n").toString("hex");
    const transport = new FakeTransport(["\r\n>", `__VSCODE_BEGIN__OK:${payload}__VSCODE_END__\r\n>`]);
    const uploader = new DirectSerialUploader(() => transport);

    const result = await uploader.download(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      "init.lua",
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.content?.toString("utf-8")).toBe("print('hi')\n");
    expect(transport.writes.map((w) => w.toString()).some((cmd) => cmd.includes("file.open(\"init.lua\",\"r\")"))).toBe(true);
  });

  it("lists device files over direct serial", async () => {
    const line1 = `${Buffer.from("init.lua").toString("hex")}\t42`;
    const line2 = `${Buffer.from("lib/foo.lua").toString("hex")}\t100`;
    const transport = new FakeTransport(["\r\n>", `__VSCODE_BEGIN__${line1}\n${line2}\n__VSCODE_END__\r\n>`]);
    const uploader = new DirectSerialUploader(() => transport);

    const result = await uploader.listFiles(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.files).toEqual([
      { name: "init.lua", size: 42 },
      { name: "lib/foo.lua", size: 100 },
    ]);
  });

  it("removes and runs files over direct serial", async () => {
    const removeTransport = new FakeTransport();
    const runTransport = new FakeTransport();
    const transports = [removeTransport, runTransport];
    const uploader = new DirectSerialUploader(() => transports.shift()!);

    const removeResult = await uploader.remove(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      "old.lua",
      () => {},
    );
    const runResult = await uploader.runFile(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      "init.lua",
      () => {},
    );

    expect(removeResult.success).toBe(true);
    expect(runResult.success).toBe(true);
    expect(removeTransport.writes.map((w) => w.toString())).toContain("file.remove(\"old.lua\")\r\n");
    expect(runTransport.writes.map((w) => w.toString())).toContain("dofile(\"init.lua\")\r\n");
  });

  it("rejects unsafe remote names", () => {
    expect(() => validateRemoteName("../init.lua")).toThrow(/Unsafe remote/);
    expect(() => validateRemoteName("/init.lua")).toThrow(/Unsafe remote/);
    expect(() => validateRemoteName("C:\\init.lua")).toThrow(/Unsafe remote/);
    expect(() => validateRemoteName("safe/init.lua")).not.toThrow();
  });

  it("toggles DTR/RTS for hard reset", async () => {
    const transport = new FakeTransport();
    const uploader = new DirectSerialUploader(() => transport);

    const result = await uploader.hardReset(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(transport.sets).toEqual([{ dtr: false, rts: true }, { dtr: false, rts: false }]);
    expect(transport.closed).toBe(true);
  });
});
