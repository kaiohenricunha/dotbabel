/** Native runtime queue ingress. A successful callback is acceptance, never model processing. */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processState, isOwnerAlive } from "../fleet/registry.mjs";
import { acquireLock } from "../lib/process-lock.mjs";
import { repository, peerRoot } from "./identity.mjs";
import { PeerStore, privatePath } from "./store.mjs";
import { nativePaths, readNativeRegistration, validateNativeId } from "./native-registry.mjs";

function boundedLine(text) {
  if (
    typeof text !== "string" ||
    /[\r\n\0]/.test(text) ||
    !text.length ||
    Buffer.byteLength(text) > 4096
  )
    throw new Error("notification must be one bounded UTF-8 line");
}
function safeSocket(socket) {
  if (!path.isAbsolute(socket ?? "")) throw new Error("native socket is unavailable");
  privatePath(path.dirname(socket), true);
  const stat = fs.lstatSync(socket);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("unsafe native socket");
}
function serveConnection(socket, who, notify, connections) {
  socket.setEncoding("utf8");
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
  socket.on("error", () => {});
  socket.setTimeout(10000, () => socket.destroy());
  let buffer = "",
    handled = false;
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 8192) {
      handled = true;
      socket.destroy();
      return;
    }
    if (!buffer.includes("\n")) return;
    handled = true;
    void acceptFrame(buffer, who, notify).then((result) => {
      if (!socket.destroyed) socket.end(JSON.stringify(result) + "\n");
    });
  });
}
async function acceptFrame(buffer, who, notify) {
  try {
    const frame = JSON.parse(buffer);
    if (
      frame.version !== 1 ||
      frame.key !== who.key ||
      frame.generation !== who.generation ||
      frame.repo !== who.repo
    )
      return { state: "failed", retryable: false, error: "native endpoint mismatch" };
    boundedLine(frame.text);
    await notify(frame.text);
    return { state: "transport_accepted", retryable: false };
  } catch {
    return { state: "uncertain", retryable: false, error: "native queue admission unconfirmed" };
  }
}

/** Register the real session supplied by a trusted native SDK/plugin. @param {object} opts @returns {Promise<object>} */
export async function openNativeEndpoint({
  harness,
  sessionId,
  worktree,
  notify,
  version = null,
  env = process.env,
}) {
  validateNativeId(harness, sessionId);
  if (typeof notify !== "function") throw new Error("native notify callback is required");
  const repo = repository(worktree),
    root = peerRoot(env);
  new PeerStore(root, repo.key);
  const key = `${harness}:${sessionId}`,
    paths = nativePaths(root, key);
  privatePath(paths.directory, true);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const lock = acquireLock(`${paths.record}.lock`, { resource: `native-peer:${key}` });
  if (!lock.acquired) throw new Error("native session registration is active");
  try {
    const previous = readNativeRegistration(root, key);
    if (previous && isOwnerAlive(previous)) throw new Error("native session is already registered");
    const generation = randomUUID(),
      socket = path.join(paths.directory, `${generation.slice(0, 18)}.sock`);
    const who = {
      key,
      harness,
      sessionId,
      repo: repo.key,
      worktree: repo.worktree,
      pid: process.pid,
      procStart: String(processState(process.pid).startTime),
      boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      nativeProtocol: 1,
      generation,
      socket,
      version,
      ended: false,
    };
    const connections = new Set();
    const server = net.createServer({ allowHalfOpen: true }, (s) =>
      serveConnection(s, who, notify, connections),
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      fs.chmodSync(socket, 0o600);
      const temporary = `${paths.record}.${generation}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(who) + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, paths.record);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    } catch (err) {
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
    let closed = false;
    return {
      who,
      async close() {
        if (closed) return;
        closed = true;
        for (const connection of connections) connection.destroy();
        await new Promise((resolve) => server.close(resolve));
        const current = readNativeRegistration(root, key);
        if (current?.generation === generation) fs.unlinkSync(paths.record);
      },
    };
  } finally {
    lock.release();
  }
}

/** Send a bounded frame to a private registered runtime queue. @param {object} who @param {string} text @param {object} [opts] @returns {Promise<object>} */
export async function deliverNative(who, text, { timeout = 5000 } = {}) {
  boundedLine(text);
  try {
    safeSocket(who.socket);
  } catch {
    return { state: "failed", retryable: false, error: "unsafe or unavailable native endpoint" };
  }
  return new Promise((resolve) => {
    let written = false,
      done = false,
      response = "";
    const socket = net.createConnection(who.socket);
    socket.setEncoding("utf8");
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    const uncertain = () =>
      finish({
        state: written ? "uncertain" : "failed",
        retryable: !written,
        error: "native queue delivery unconfirmed",
      });
    socket.setTimeout(timeout, uncertain);
    socket.on("error", uncertain);
    socket.on("close", () => {
      if (!done) uncertain();
    });
    socket.on("connect", () => {
      written = true;
      socket.end(
        JSON.stringify({
          version: 1,
          key: who.key,
          generation: who.generation,
          repo: who.repo,
          text,
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response) > 4096) {
        uncertain();
        return;
      }
      if (!response.includes("\n")) return;
      try {
        const result = JSON.parse(response);
        if (
          !["transport_accepted", "failed", "uncertain"].includes(result.state) ||
          typeof result.retryable !== "boolean"
        ) {
          uncertain();
          return;
        }
        finish(result);
      } catch {
        uncertain();
      }
    });
  });
}
