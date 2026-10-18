/** Bounded projection I/O anchored to directory descriptors; no symlink traversal. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const EXCHANGE_HELPER = fileURLToPath(new URL("./projection-exchange.py", import.meta.url));

/** @param {unknown} value @returns {boolean} Whether a portable relative path is confined syntactically. */
export const isProjectionPath = value => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[:\\\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

function openOwningRoot(root) {
  let fd;
  try {
    fd = fs.openSync("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    for (const part of path.resolve(root).split("/").filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    return fd;
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw fail("projection_path_unsafe");
  }
}
function readAt(file) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail("projection_file_unavailable");
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break; length += count;
    }
    if (length > stat.size) throw fail("projection_file_unavailable");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw fail("projection_path_unsafe");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function exchange(fd, first, second) {
  const result = childProcess.spawnSync("python3", ["-I", EXCHANGE_HELPER, first, second], {
    stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000, maxBuffer: 4096,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) throw fail("projection_atomic_exchange_unavailable");
}
function unlinkTemporary(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

/**
 * Open an existing real owning root through a no-follow descriptor walk.
 * Atomic replacement uses Linux renameat2 through an isolated Python 3 standard-library helper.
 * @param {string} root Existing owning directory, containing no symlink component.
 * @returns {object} Bounded read, conflict-preserving write/remove and close operations.
 */
export function openProjectionTree(root) {
  if (process.platform !== "linux") throw fail("projection_filesystem_unavailable");
  const rootFd = openOwningRoot(root);
  const parent = (relative, create = false) => {
    if (!isProjectionPath(relative)) throw fail("projection_path_unsafe");
    const parts = relative.split("/"); const name = parts.pop(); const opened = [];
    let fd = rootFd;
    try {
      for (const part of parts) {
        const child = `/proc/self/fd/${fd}/${part}`;
        if (create) { try { fs.mkdirSync(child); } catch (error) { if (error.code !== "EEXIST") throw error; } }
        fd = fs.openSync(child, O_RDONLY | O_DIRECTORY | O_NOFOLLOW); opened.push(fd);
      }
      return { fd, name, path: `/proc/self/fd/${fd}/${name}`, close: () => opened.reverse().forEach(fd => fs.closeSync(fd)) };
    } catch (error) {
      opened.reverse().forEach(fd => fs.closeSync(fd));
      if (error.code === "ENOENT" && !create) return null;
      throw fail("projection_path_unsafe");
    }
  };
  const read = relative => {
    const location = parent(relative); if (location === null) return null;
    try { return readAt(location.path); } finally { location.close(); }
  };
  const write = (relative, content, options = {}) => {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail("projection_file_unavailable");
    const location = parent(relative, true); const temporaryName = location.name + "." + randomUUID() + ".tmp";
    const temporary = `/proc/self/fd/${location.fd}/${temporaryName}`; let retain = false;
    try {
      const observed = readAt(location.path);
      if (options.expected !== undefined && observed !== options.expected || options.exclusive && observed !== null) throw fail("projection_output_drift");
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (observed === null) fs.linkSync(temporary, location.path);
      else {
        // Retain both objects on an ambiguous helper exit or a conflicting displaced value.
        retain = true; exchange(location.fd, temporaryName, location.name);
        let displaced;
        try { displaced = readAt(temporary); } catch { displaced = undefined; }
        if (displaced !== observed) {
          try { exchange(location.fd, temporaryName, location.name); } catch { /* Both objects remain retained. */ }
          throw fail("projection_output_drift");
        }
        retain = false;
      }
      unlinkTemporary(temporary); fs.fsyncSync(location.fd);
    } catch (error) {
      if (error.code?.startsWith("projection_")) throw error;
      throw fail(error.code === "EEXIST" ? "projection_output_drift" : "projection_write_failed");
    } finally {
      try { if (!retain) unlinkTemporary(temporary); } finally { location.close(); }
    }
  };
  const remove = (relative, options = {}) => {
    const location = parent(relative); if (location === null) return;
    const temporary = location.path + "." + randomUUID() + ".tmp"; let retain = false;
    try {
      const observed = readAt(location.path); if (observed === null) return;
      if (options.expected !== undefined && observed !== options.expected) throw fail("projection_output_drift");
      fs.renameSync(location.path, temporary); retain = true;
      if (readAt(temporary) !== observed) {
        // Exclusive restoration never overwrites a new file created at the original path.
        try { fs.linkSync(temporary, location.path); } catch { /* Preserve the displaced object. */ }
        throw fail("projection_output_drift");
      }
      retain = false; unlinkTemporary(temporary); fs.fsyncSync(location.fd);
    } finally {
      try { if (!retain) unlinkTemporary(temporary); } finally { location.close(); }
    }
  };
  return { read, write, remove, ensureDirectory: relative => parent(relative + "/.unused", true).close(), close: () => fs.closeSync(rootFd), lockPath: `/proc/self/fd/${rootFd}/.dotbabel-projection.lock` };
}
