/**
 * Unit tests for LiveEditFileSystemProvider (src/device/liveEditFs.ts).
 *
 * These run without VS Code — the test host supplies a minimal vscode shim via
 * tsconfig paths (node_modules/@types/vscode).  The provider itself only uses
 * vscode.{FileSystemProvider, FileChangeType, FileSystemError, FileType,
 * EventEmitter, Disposable, Uri}, all of which are available in the test env
 * through the vscode-mock shim already set up for unit tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LiveEditFileSystemProvider, LIVE_EDIT_SCHEME } from "../../src/device/liveEditFs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return Buffer.from(s, "utf-8");
}

function text(buf: Uint8Array): string {
  return Buffer.from(buf).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiveEditFileSystemProvider", () => {
  let fs: LiveEditFileSystemProvider;

  beforeEach(() => {
    fs = new LiveEditFileSystemProvider();
  });

  // --- setDocument / readFile round-trip -----------------------------------

  it("setDocument stores content and readFile returns it unchanged", () => {
    const content = enc("print('hello')\n");
    fs.setDocument({ port: "COM7", remoteName: "init.lua" }, content);

    const uri = fs.makeUri({ port: "COM7", remoteName: "init.lua" });
    expect(text(fs.readFile(uri))).toBe("print('hello')\n");
  });

  it("readFile throws FileNotFound for an unknown URI", () => {
    const uri = fs.makeUri({ port: "COM7", remoteName: "missing.lua" });
    expect(() => fs.readFile(uri)).toThrow();
  });

  // --- stat ----------------------------------------------------------------

  it("stat returns size equal to content byte length", () => {
    const content = enc("hello world");
    const uri = fs.setDocument({ port: "COM7", remoteName: "test.lua" }, content);
    const s = fs.stat(uri);
    expect(s.size).toBe(content.byteLength);
  });

  it("stat throws FileNotFound for an unknown URI", () => {
    const uri = fs.makeUri({ port: "COM7", remoteName: "ghost.lua" });
    expect(() => fs.stat(uri)).toThrow();
  });

  // --- getMetadata ---------------------------------------------------------

  it("getMetadata returns port and remoteName set via setDocument", () => {
    const uri = fs.setDocument({ port: "COM7", remoteName: "init.lua" }, enc(""));
    const meta = fs.getMetadata(uri);
    expect(meta?.port).toBe("COM7");
    expect(meta?.remoteName).toBe("init.lua");
  });

  it("getMetadata returns undefined for unknown URI", () => {
    const uri = fs.makeUri({ port: "COM7", remoteName: "nonexistent.lua" });
    expect(fs.getMetadata(uri)).toBeUndefined();
  });

  // --- writeFile -----------------------------------------------------------

  it("writeFile updates content while preserving metadata", () => {
    const uri = fs.setDocument({ port: "COM7", remoteName: "init.lua" }, enc("old"));
    fs.writeFile(uri, enc("new content"));
    expect(text(fs.readFile(uri))).toBe("new content");
    // metadata must survive
    expect(fs.getMetadata(uri)?.remoteName).toBe("init.lua");
    expect(fs.getMetadata(uri)?.port).toBe("COM7");
  });

  it("writeFile on a never-setDocument URI derives metadata from the URI itself", () => {
    const uri = fs.makeUri({ port: "COM3", remoteName: "module.lua" });
    // Should not throw — provider derives metadata from URI path
    fs.writeFile(uri, enc("data"));
    expect(text(fs.readFile(uri))).toBe("data");
    // Metadata recovery from URI
    const meta = fs.getMetadata(uri);
    expect(meta?.port).toBe("COM3");
    expect(meta?.remoteName).toBe("module.lua");
  });

  // --- delete --------------------------------------------------------------

  it("delete removes the entry so subsequent readFile throws", () => {
    const uri = fs.setDocument({ port: "COM7", remoteName: "bye.lua" }, enc("bye"));
    fs.delete(uri);
    expect(() => fs.readFile(uri)).toThrow();
  });

  // --- rename --------------------------------------------------------------

  it("rename moves content to new URI and old URI is gone", () => {
    const oldUri = fs.setDocument({ port: "COM7", remoteName: "old.lua" }, enc("content"));
    const newUri = fs.makeUri({ port: "COM7", remoteName: "new.lua" });
    fs.rename(oldUri, newUri);

    expect(text(fs.readFile(newUri))).toBe("content");
    expect(() => fs.readFile(oldUri)).toThrow();
  });

  it("rename on missing source throws", () => {
    const oldUri = fs.makeUri({ port: "COM7", remoteName: "ghost.lua" });
    const newUri = fs.makeUri({ port: "COM7", remoteName: "target.lua" });
    expect(() => fs.rename(oldUri, newUri)).toThrow();
  });

  // --- URI encoding --------------------------------------------------------

  it("makeUri produces a nodemcu-live: URI with the correct scheme", () => {
    const uri = fs.makeUri({ port: "COM7", remoteName: "init.lua" });
    expect(uri.scheme).toBe(LIVE_EDIT_SCHEME);
  });

  it("port with special characters is percent-encoded in the URI", () => {
    // On Linux /dev/ttyUSB0 has a slash which must be encoded
    const uri = fs.makeUri({ port: "/dev/ttyUSB0", remoteName: "init.lua" });
    expect(uri.toString()).not.toContain("/dev/ttyUSB0");
    // Round-trip via setDocument should still work
    fs.setDocument({ port: "/dev/ttyUSB0", remoteName: "init.lua" }, enc("body"));
    const retrieved = fs.getMetadata(uri);
    expect(retrieved?.port).toBe("/dev/ttyUSB0");
  });

  it("remote names with subdirectories survive URI round-trip", () => {
    const uri = fs.setDocument({ port: "COM7", remoteName: "sub/dir/file.lua" }, enc("ok"));
    const meta = fs.getMetadata(uri);
    expect(meta?.remoteName).toBe("sub/dir/file.lua");
  });

  // --- onDidChangeFile event -----------------------------------------------

  it("fires onDidChangeFile when setDocument is called", async () => {
    const events: unknown[] = [];
    fs.onDidChangeFile((e) => events.push(e));

    fs.setDocument({ port: "COM7", remoteName: "watch.lua" }, enc("body"));
    // Allow microtask queue to flush
    await Promise.resolve();
    expect(events).toHaveLength(1);
  });

  it("fires onDidChangeFile when delete is called", async () => {
    const uri = fs.setDocument({ port: "COM7", remoteName: "del.lua" }, enc(""));
    const events: unknown[] = [];
    fs.onDidChangeFile((e) => events.push(e));

    fs.delete(uri);
    await Promise.resolve();
    expect(events).toHaveLength(1);
  });
});
