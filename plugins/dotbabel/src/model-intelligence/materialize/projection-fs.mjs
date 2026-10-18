/** Bounded projection I/O anchored to directory descriptors; no symlink traversal. */
import fs from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });

/** @param {unknown} value @returns {boolean} Whether a portable relative path is confined syntactically. */
export const isProjectionPath = value => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[:\\\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

/**
 * Open an existing real owning root. Linux fd paths keep parent replacements from redirecting I/O.
 * Other hosts fail closed until an equivalent descriptor-relative mechanism is verified.
 * @param {string} root Existing owning directory, containing no symlink component.
 * @returns {object} Bounded read, atomic write, remove and close operations.
 */
export function openProjectionTree(root) {
  if (process.platform !== "linux") throw fail("projection_filesystem_unavailable");
  let rootFd;
  try {
    if (fs.realpathSync(root) !== resolve(root)) throw fail("projection_path_unsafe");
    rootFd = fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch { throw fail("projection_path_unsafe"); }
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
      return { path: `/proc/self/fd/${fd}/${name}`, close: () => opened.reverse().forEach(fd => fs.closeSync(fd)) };
    } catch (error) {
      opened.reverse().forEach(fd => fs.closeSync(fd));
      if (error.code === "ENOENT" && !create) return null;
      throw fail("projection_path_unsafe");
    }
  };
  const read = relative => {
    const location = parent(relative); if (location === null) return null;
    let fd;
    try {
      fd = fs.openSync(location.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail("projection_file_unavailable");
      const bytes = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break; length += count;
      }
      if (length > stat.size) throw fail("projection_file_unavailable");
      return bytes.toString("utf8", 0, length);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw fail("projection_path_unsafe");
    } finally { if (fd !== undefined) fs.closeSync(fd); location.close(); }
  };
  const write = (relative, content, { exclusive = false } = {}) => {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail("projection_file_unavailable");
    const location = parent(relative, true); const temporary = location.path + "." + randomUUID() + ".tmp";
    try {
      let stat;
      try { stat = fs.lstatSync(location.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat && !stat.isFile()) throw fail("projection_path_unsafe");
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (exclusive) { fs.linkSync(temporary, location.path); fs.unlinkSync(temporary); }
      else fs.renameSync(temporary, location.path);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      location.close();
    }
  };
  const remove = relative => {
    const location = parent(relative); if (location === null) return;
    try {
      const stat = fs.lstatSync(location.path);
      if (!stat.isFile()) throw fail("projection_path_unsafe");
      fs.unlinkSync(location.path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { location.close(); }
  };
  return { read, write, remove, ensureDirectory: relative => parent(relative + "/.unused", true).close(), close: () => fs.closeSync(rootFd), lockPath: `/proc/self/fd/${rootFd}/.dotbabel-projection.lock` };
}
