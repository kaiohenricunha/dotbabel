/** Harness adapters: transport acceptance never claims model processing. No credentials are read. */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

function claude(who, text, timeout) {
  if (who.peerProtocol !== 1)
    return Promise.resolve({
      state: "failed",
      error: "unsupported Claude peer protocol; use receive/next fallback",
      retryable: false,
    });
  try {
    if (!path.isAbsolute(who.socket ?? "")) throw new Error("missing Claude socket");
    const stat = fs.lstatSync(who.socket),
      parent = fs.lstatSync(path.dirname(who.socket));
    if (!stat.isSocket() || stat.isSymbolicLink() || parent.isSymbolicLink())
      throw new Error("unsafe socket path or symlink");
    if (process.getuid && (stat.uid !== process.getuid() || parent.uid !== process.getuid()))
      throw new Error("foreign socket owner");
    if (stat.mode & 0o077 || parent.mode & 0o022) throw new Error("unsafe socket permissions");
  } catch (err) {
    return Promise.resolve({
      state: "failed",
      error: err.message,
      retryable: err.code === "ENOENT",
    });
  }
  return new Promise((resolve) => {
    let connected = false,
      done = false;
    const socket = net.createConnection(who.socket);
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () =>
      finish({
        state: connected ? "uncertain" : "failed",
        retryable: !connected,
        error: "Claude socket timeout",
      }),
    );
    socket.on("error", (err) =>
      finish({
        state: connected ? "uncertain" : "failed",
        error: `Claude socket ${err.code ?? "error"}`,
        retryable: !connected,
      }),
    );
    socket.on("connect", () => {
      connected = true;
      // Claude 2.1.302, peerProtocol=1: one plain UTF-8 line. Tested against
      // its live stream-json command lifecycle. No invented sender/mode or
      // own-child auth token: all inbound permission controls still apply.
      socket.end(`${text}\n`, () => finish({ state: "transport_accepted", retryable: false }));
    });
    socket.on("close", () => {
      if (!done)
        finish({
          state: "uncertain",
          retryable: false,
          error: "socket closed without write confirmation",
        });
    });
  });
}
function codex(who, text, bin, timeout) {
  return new Promise((resolve) => {
    let timedOut = false,
      done = false;
    const child = spawn(bin, ["queue", "--thread", who.sessionId, "--message", text], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    const hard = setTimeout(() => child.kill("SIGKILL"), timeout + 1000);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hard);
      resolve(result);
    };
    child.on("error", (err) =>
      finish({
        state: "failed",
        error: `Codex queue ${err.code ?? "spawn error"}`,
        retryable: false,
      }),
    );
    child.on("exit", (code, signal) =>
      finish(
        code === 0
          ? { state: "transport_accepted", retryable: false }
          : {
              state: "uncertain",
              retryable: false,
              error: timedOut
                ? "Codex queue timeout"
                : `Codex queue exited ${code ?? signal}; delivery unconfirmed`,
            },
      ),
    );
  });
}

/** Send a single notification to an existing session. @param {object} who @param {string} text @param {object} [opts] @returns {Promise<object>} */
export async function deliver(who, text, { timeout = 5000, codexBin = "codex" } = {}) {
  if (typeof text !== "string" || /[\r\n\0]/.test(text) || Buffer.byteLength(text) > 4096)
    throw new Error("notification must be one bounded UTF-8 line");
  if (who.harness === "claude") return claude(who, text, timeout);
  if (who.harness === "codex") return codex(who, text, codexBin, timeout);
  return { state: "failed", retryable: false, error: "unsupported harness" };
}
