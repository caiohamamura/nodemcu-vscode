import * as fs from "node:fs";
import * as path from "node:path";
import type { FileEntry } from "./nodemcuTool";

export interface LocalMirrorFile {
  localPath: string;
  remoteName: string;
}

export interface MirrorPlan {
  upload: LocalMirrorFile[];
  remove: string[];
}

export function getFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === "." || file === "..") continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === ".git" || file === "node_modules" || file === ".vscode" || file === ".tmp-user-dir" || file === ".tmp-extensions") {
        continue;
      }
      results = results.concat(getFilesRecursively(fullPath));
    } else if (stat.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function localFilesForSrc(srcDir: string): LocalMirrorFile[] {
  return getFilesRecursively(srcDir).map((file) => ({
    localPath: file,
    remoteName: path.relative(srcDir, file).replace(/\\/g, "/"),
  }));
}

export function planMirrorSync(opts: {
  srcDir: string;
  remoteFiles: FileEntry[];
  uploadTimestamps?: Record<string, number>;
  uploadHashes?: Record<string, string>;
  hashFile?: (filePath: string) => string | null;
  changedOnly?: boolean;
  // Files whose remoteName matches are excluded from the SPIFFS upload set; any
  // remote copy of them is scheduled for removal instead. Used for LFS-bound Lua
  // modules, which live in the flash store rather than SPIFFS.
  excludeRemoteName?: (remoteName: string) => boolean;
}): MirrorPlan {
  const exclude = opts.excludeRemoteName ?? (() => false);
  const localFiles = localFilesForSrc(opts.srcDir).filter((file) => !exclude(file.remoteName));
  const remoteNames = new Set(localFiles.map((file) => file.remoteName));
  const upload = opts.changedOnly
    ? localFiles.filter((file) => {
        if (!fs.existsSync(file.localPath)) return false;
        // Prefer content hashes when available: a no-op save still bumps mtime,
        // so mtime alone re-uploads byte-identical files. A matching hash means
        // the contents are exactly what we last uploaded — skip it.
        if (opts.hashFile && opts.uploadHashes) {
          const hash = opts.hashFile(file.localPath);
          if (hash != null) {
            return opts.uploadHashes[file.localPath] !== hash;
          }
        }
        const mtime = fs.statSync(file.localPath).mtimeMs;
        const lastMtime = opts.uploadTimestamps?.[file.localPath] ?? 0;
        return mtime > lastMtime;
      })
    : localFiles;
  const remove = opts.remoteFiles
    .map((file) => file.name)
    .filter((name) => !remoteNames.has(name));
  return { upload, remove };
}
