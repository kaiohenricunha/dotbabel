/** Bounded stdio transport for a caller-owned Codex App Server session. No credential reads or retries. */
import { spawn } from "node:child_process";

const failure = (code, nativeCode) => Object.assign(new Error(code), { code, ...(nativeCode === undefined ? {} : { nativeCode }) });

/**
 * Start the native App Server and preserve JSON-RPC parameters, notifications and approval requests.
 * A permission request requires the caller's handler; missing or failing handlers never approve it.
 * The transport inherits native authentication without reading, copying or logging credentials.
 * @param {object} [options] Command/argument array, cwd, request timeout, maximum line bytes and
 * onServerRequest(method, params). The alternate command is useful for subprocess contract tests.
 * @returns {{request: Function, sendNotification: Function, onNotification: Function, close: Function, diagnostics: object[]}} Native protocol transport.
 */
export function createCodexRpcTransport(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxLineBytes = options.maxLineBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 128 || maxLineBytes > 64 * 1024 * 1024) throw new TypeError("invalid native transport bounds");
  const child = spawn(options.command ?? "codex", options.args ?? ["app-server"], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
  const pending = new Map();
  const listeners = new Set();
  const diagnostics = [];
  const diagnose = (code, method) => {
    if (diagnostics.length === 32) diagnostics.shift();
    diagnostics.push({ code, ...(method === undefined ? {} : { method }) });
  };
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let closed = false;

  const close = (code = "native_transport_closed") => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure(code)); }
    pending.clear(); listeners.clear(); buffer = Buffer.alloc(0);
    child.stdin.end(); child.kill("SIGTERM");
  };
  const write = message => child.stdin.write(JSON.stringify(message) + "\n");
  const receive = message => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return close("native_protocol_invalid");
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        Promise.resolve().then(async () => {
          if (typeof options.onServerRequest !== "function") {
            diagnose("native_handler_unavailable", message.method);
            return { id: message.id, error: { code: -32601, message: "No caller handler is available" } };
          }
          try { return { id: message.id, result: await options.onServerRequest(message.method, message.params) }; }
          catch { diagnose("native_handler_failed", message.method); return { id: message.id, error: { code: -32603, message: "The caller handler failed" } }; }
        }).then(response => { if (!closed) write(response); }).catch(() => close());
      } else {
        for (const listener of listeners) {
          try { Promise.resolve(listener(message)).catch(() => diagnose("native_observer_failed")); }
          catch { diagnose("native_observer_failed"); }
        }
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(failure("native_rpc_rejected", typeof message.error.code === "number" ? message.error.code : undefined));
    else if (Object.hasOwn(message, "result")) item.resolve(message.result);
    else { item.reject(failure("native_protocol_invalid")); close("native_protocol_invalid"); }
  };
  child.stdout.on("data", chunk => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    let boundary;
    while ((boundary = buffer.indexOf(10)) !== -1) {
      if (boundary > maxLineBytes) return close("native_protocol_too_large");
      const line = buffer.subarray(0, boundary).toString("utf8"); buffer = buffer.subarray(boundary + 1);
      let message;
      try { message = JSON.parse(line); } catch { return close("native_protocol_invalid"); }
      receive(message);
      if (closed) return;
    }
    if (buffer.length > maxLineBytes) close("native_protocol_too_large");
  });
  child.stderr.resume();
  child.on("error", () => close()); child.on("close", () => close()); child.stdin.on("error", () => close());

  return {
    get diagnostics() { return diagnostics.map(item => ({ ...item })); },
    sendNotification(method, params) {
      if (closed || typeof method !== "string" || method.length === 0) return false;
      try { write({ method, params }); return true; } catch { close(); return false; }
    },
    request(method, params) {
      if (closed) return Promise.reject(failure("native_transport_closed"));
      if (typeof method !== "string" || method.length === 0 || pending.size >= 128 || nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(failure("native_rpc_limit"));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(failure("native_rpc_timeout")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); } catch { close(); }
      });
    },
    onNotification(listener) {
      if (typeof listener !== "function" || listeners.size >= 32) throw new TypeError("invalid native observer");
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() { close(); },
  };
}
