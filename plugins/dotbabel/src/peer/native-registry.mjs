/** Private, process-fenced registrations created by native runtime integrations. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isOwnerAlive, processState } from "../fleet/registry.mjs";
import { privatePath } from "./store.mjs";

/** Runtime names accepted by the native endpoint protocol. */
export const NATIVE_HARNESSES = Object.freeze(["opencode", "copilot", "antigravity"]);

/** Validate native IDs without treating a supplied ID as an authenticated actor. @param {string} harness @param {string} sessionId @returns {void} */
export function validateNativeId(harness, sessionId) {
  if (!NATIVE_HARNESSES.includes(harness)) throw new Error("unsupported native harness");
  const pattern =
    harness === "opencode"
      ? /^ses[a-zA-Z0-9_-]{1,120}$/
      : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (typeof sessionId !== "string" || !pattern.test(sessionId))
    throw new Error("unsafe native session id");
}

/** Locate one registration by its bounded harness-qualified key. @param {string} root @param {string} key @returns {object} */
export function nativePaths(root, key) {
  const directory = path.join(root, "native");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return { directory, record: path.join(directory, `${hash}.json`) };
}

/** Read only a private native registration. @param {string} root @param {string} key @returns {object|null} */
export function readNativeRegistration(root, key) {
  const paths = nativePaths(root, key);
  try {
    privatePath(root, true);
    privatePath(paths.directory, true);
    privatePath(paths.record);
    const fd = fs.openSync(paths.record, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value;
    try {
      if (fs.fstatSync(fd).size > 8192) throw new Error("native registration too large");
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    validateNativeId(value.harness, value.sessionId);
    if (value.key !== key || value.nativeProtocol !== 1 || !path.isAbsolute(value.socket))
      return null;
    return value;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Verify both the process incarnation and the exact registered endpoint. @param {object} who @param {string} root @returns {boolean} */
export function nativeAlive(who, root) {
  try {
    const registered = readNativeRegistration(root, who.key);
    return Boolean(
      registered &&
      !who.ended &&
      isOwnerAlive(registered) &&
      [
        "harness",
        "sessionId",
        "repo",
        "worktree",
        "pid",
        "procStart",
        "socket",
        "generation",
      ].every((key) => registered[key] === who[key]),
    );
  } catch {
    return false;
  }
}

function descendant(startPid, ownerPid) {
  let pid = startPid;
  for (let n = 0; n < 64 && pid > 1; n++) {
    if (pid === ownerPid) return true;
    pid = processState(pid).ppid ?? 0;
  }
  return false;
}

/** Resolve a shell only when its live native registration owns its ancestry. @param {object} repo @param {object} opts @returns {object|null} */
export function currentNativeSession(repo, { root, key, startPid }) {
  if (!key) return null;
  const who = readNativeRegistration(root, key);
  if (!who || !nativeAlive(who, root) || !descendant(startPid, who.pid))
    throw new Error("native session registration or process ancestry is unavailable");
  if (who.repo !== repo.key || who.worktree !== repo.worktree)
    throw new Error("native session repository mismatch");
  return who;
}
