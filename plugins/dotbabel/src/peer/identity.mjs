/** Local session identities, reusing Fleet's Claude registry and Linux incarnation checks. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { normalizeRemote } from "../fleet/policy.mjs";
import {
  findSelf,
  readRegistry,
  sessionsDir,
  processState,
  isOwnerAlive,
} from "../fleet/registry.mjs";
import { currentNativeSession, nativeAlive, NATIVE_HARNESSES } from "./native-registry.mjs";

function git(cwd, args) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  return execFileSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  }).trim();
}
function bootId() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/** Resolve shared Git origin identity and the actual worktree. @param {string} cwd @returns {object} */
export function repository(cwd) {
  const worktree = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  let remote;
  try {
    remote = git(worktree, ["config", "--get", "remote.origin.url"]);
  } catch {
    remote = null;
  }
  return { key: normalizeRemote(remote) ?? `local:${fs.realpathSync(common)}`, worktree, common };
}

/** Private peer state root beside Fleet state, with an explicit test/operator override. @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function peerRoot(env = process.env) {
  return (
    env.DOTBABEL_PEER_STATE_DIR ||
    path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "dotbabel", "peer")
  );
}

function codexAncestor(startPid) {
  let pid = startPid;
  for (let n = 0; n < 64 && pid > 1; n++) {
    const proc = processState(pid);
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (
        path.basename(argv[0]) === "codex" ||
        (path.basename(argv[0]) === "node" && /(?:^|\/)codex(?:\.js)?$/.test(argv[1] ?? ""))
      )
        return { pid, procStart: proc.startTime };
    } catch {
      /* A parent can exit during discovery. */
    }
    pid = proc.ppid ?? 0;
  }
  return null;
}

function foreignNativeAncestor(startPid) {
  let pid = startPid;
  for (let n = 0; n < 64 && pid > 1; n++) {
    const proc = processState(pid);
    let argv = [];
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {}
    const binary = path.basename(argv[0] || ""),
      script = argv[1] || "";
    if (
      ["codex", "claude"].includes(binary) ||
      (binary === "node" && /(?:^|\/)(?:codex|claude)(?:\.js)?$/.test(script))
    )
      return false;
    if (
      /^(?:opencode(?:\.exe)?|copilot|agy|antigravity)$/.test(binary) ||
      (["node", "bun"].includes(binary) &&
        /(?:\/@github\/copilot\/(?:index|copilot)\.(?:m?js)|\/(?:copilot|opencode)(?:\.(?:m?js))?)$/.test(
          script,
        ))
    )
      return true;
    pid = proc.ppid ?? 0;
  }
  return false;
}

/** Resolve the invoking session without guessing a recent transcript. @param {object} repo @param {object} [opts] @returns {object} */
export function currentSession(
  repo,
  { env = process.env, startPid = process.ppid, sessionId } = {},
) {
  const native = currentNativeSession(repo, {
    root: peerRoot(env),
    key: env.DOTBABEL_PEER_NATIVE_SESSION,
    startPid,
  });
  if (native) return native;
  if (foreignNativeAncestor(startPid))
    throw new Error(
      "native runtime requires its installed peer integration; inherited Claude/Codex identity is refused",
    );
  const entries = readRegistry(sessionsDir(env)).entries;
  const claude = findSelf({ entries, startPid, sessionId });
  let who;
  if (claude) {
    who = { ...claude, harness: "claude", socket: claude.messagingSocketPath ?? null };
    // Never persist an authentication token, nor arbitrary registry metadata.
  } else {
    const id = sessionId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
    const owner = id ? codexAncestor(startPid) : null;
    if (!owner)
      throw new Error(
        "cannot resolve a live Claude or Codex session; run inside its tool shell, or install/trust peer hooks and restart/resume for a namespaced Codex shell",
      );
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
      throw new Error("unsafe Codex session id");
    who = { ...owner, harness: "codex", sessionId: id, version: env.CODEX_VERSION ?? null };
  }
  if (!who.sessionId || !who.procStart)
    throw new Error("session identity lacks a process incarnation (Linux/WSL2 required)");
  if (who.cwd && repository(who.cwd).key !== repo.key)
    throw new Error("invoking session repository mismatch");
  return {
    key: `${who.harness}:${who.sessionId}`,
    harness: who.harness,
    sessionId: who.sessionId,
    pid: who.pid,
    procStart: String(who.procStart),
    boot: bootId(),
    repo: repo.key,
    worktree: repo.worktree,
    version: who.version ?? null,
    peerProtocol: who.peerProtocol ?? null,
    socket: who.socket ?? null,
    ended: false,
  };
}

/** Check incarnation, worktree, repository, and Claude's current session ID. @param {object} who @param {object} [opts] @returns {boolean} */
export function endpointAlive(who, { env = process.env } = {}) {
  if (!who || who.ended || (who.boot && who.boot !== bootId()) || !isOwnerAlive(who)) return false;
  try {
    if (repository(who.worktree).key !== who.repo) return false;
  } catch {
    return false;
  }
  if (NATIVE_HARNESSES.includes(who.harness)) return nativeAlive(who, peerRoot(env));
  if (who.harness === "claude") {
    return readRegistry(sessionsDir(env)).entries.some(
      (e) =>
        e.pid === who.pid && String(e.procStart) === who.procStart && e.sessionId === who.sessionId,
    );
  }
  // Codex CLI's shared daemon can outlive its thread. SessionEnd hooks mark
  // ended; queue errors and missing processing ACKs expose other failures.
  return who.harness === "codex";
}
