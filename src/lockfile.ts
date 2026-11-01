// The file Glut finds this editor by: ~/.glut/ide/<port>.json with the port, the folders and a fresh token — the
// folder 0700, the file 0600, written under another name and renamed into place, removed when the editor stops. A file
// an editor left behind when it ended without stopping is swept at start.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** The folder the editors leave their files in, below `home`. */
export function dir(home: string = os.homedir()): string {
  return path.join(home, ".glut", "ide");
}

/** A token from the system's random source: 16 bytes as 32 hex characters. */
export function token(): string {
  return randomBytes(16).toString("hex");
}

/** Whether `pid` is a live process this user may signal. */
function alive(pid: number): boolean {
  // 0 and below name process groups, not one process.
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Removes the files of editors whose process is gone. */
export function sweep(home?: string): void {
  const folder = dir(home);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    const file = path.join(folder, name);
    let pid: unknown;
    try {
      pid = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    } catch {
      pid = undefined;
    }
    if (typeof pid !== "number" || !alive(pid)) {
      fs.rmSync(file, { force: true });
    }
  }
}

/** Writes the file for `port`, naming `ide` and its `folders`; returns its path. */
export function write(port: number, secret: string, ide: string, folders: string[], home?: string): string {
  const folder = dir(home);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // An existing folder keeps its mode: closed to everyone else, or Glut does not read it.
  fs.chmodSync(folder, 0o700);
  const file = path.join(folder, `${port}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify({
    version: 1,
    port,
    pid: process.pid,
    ideName: ide,
    // Glut compares its real working folder: a folder opened through a link is named where it really is.
    workspaceFolders: folders.map((folder) => {
      try {
        return fs.realpathSync(folder);
      } catch {
        return folder;
      }
    }),
    authToken: secret,
  });
  fs.rmSync(temporary, { force: true });
  // Created new, never through a file or a link already there, readable by the owner alone from its first byte.
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  return file;
}

/** Removes the file at `file`, if any. */
export function remove(file: string | undefined): void {
  if (file) {
    fs.rmSync(file, { force: true });
  }
}
