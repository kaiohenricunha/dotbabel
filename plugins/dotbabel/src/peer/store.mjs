/** Crash-safe private repository state, using Dotbabel's existing process-incarnation lock. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock } from "../lib/process-lock.mjs";
import { createState, textBody } from "./state.mjs";

const REQUEST_STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "waiting_for_peer",
]);
const DELIVERY_STATES = new Set([
  "persisted",
  "sending",
  "uncertain",
  "failed",
  "transport_accepted",
  "delivered",
  "processed",
  "acknowledged",
]);
const MESSAGE_KINDS = new Set([
  "finding",
  "question",
  "reply",
  "recommendation",
  "acknowledgment",
  "status",
]);
function validText(value) {
  try {
    textBody(value);
    return true;
  } catch {
    return false;
  }
}

/** Refuse symlinked, foreign-owner, or public state paths. @param {string} file @param {boolean} [directory] @param {boolean} [requirePrivate] @returns {void} */
export function privatePath(file, directory = false, requirePrivate = true) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink: ${file}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`foreign owner: ${file}`);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw new Error(`unexpected state path type: ${file}`);
  if (requirePrivate && stat.mode & 0o077)
    throw new Error(`state permissions must be private: ${file}`);
}

function validate(s, repo) {
  if (!s || s.version !== 1 || s.repo !== repo || !Array.isArray(s.pairs))
    throw new Error("unsupported peer state version or repository");
  for (const p of s.pairs) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !Array.isArray(p.messages) ||
      !Array.isArray(p.requests) ||
      !p.main?.key ||
      !Number.isInteger(p.sequence) ||
      p.sequence < 0 ||
      p.requests.filter((r) => r?.state === "running").length > 1
    )
      throw new Error("malformed peer pair");
    for (const m of p.messages)
      if (
        !m ||
        m.version !== 1 ||
        m.pair_id !== p.id ||
        !validText(m.body) ||
        !MESSAGE_KINDS.has(m.kind) ||
        !DELIVERY_STATES.has(m.delivery?.state) ||
        typeof m.to !== "string"
      )
        throw new Error("malformed peer message");
    for (const r of p.requests)
      if (
        !r ||
        typeof r.id !== "string" ||
        !validText(r.body) ||
        !REQUEST_STATES.has(r.state) ||
        (r.state === "running" && (typeof r.lease !== "string" || !r.lease))
      )
        throw new Error("malformed peer request");
  }
}

// JSON can encode one UTF-8 byte as six bytes (for example, U+0001).
// Results occur in both result and outcome. Control space covers the bounded
// 500-character adapter diagnostic (up to 3000 encoded bytes), tokens and timestamps.
const ADMISSION_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_BYTES = 48 * 1024 * 1024;
const CONTROL_BYTES = 4096;
const RESULT_BYTES = 2 * 6 * 16384;
const REQUEST_CONTROL = [
  "state",
  "attempts",
  "lease",
  "dispatch",
  "recovery",
  "started_at",
  "finished_at",
  "waiting_on",
];
const PAIR_CONTROL = ["closed", "paused", "relay", "availability"];
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}
function controlBytes(value, keys) {
  // A sentinel keeps comma accounting stable when the first optional field appears.
  return jsonBytes(Object.fromEntries([["_", 0], ...keys.map((key) => [key, value?.[key]])]));
}
function capacityCharge(s, bytes) {
  let reserved = 0;
  for (const p of s.pairs) {
    if (p.closed) continue;
    const pairControl =
      controlBytes(p, PAIR_CONTROL) +
      controlBytes(p.main, ["ended"]) +
      controlBytes(p.advisor, ["ended"]);
    reserved += Math.max(0, CONTROL_BYTES - pairControl);
    for (const r of p.requests) {
      if (["completed", "failed", "cancelled"].includes(r.state)) continue;
      reserved += RESULT_BYTES + Math.max(0, CONTROL_BYTES - controlBytes(r, REQUEST_CONTROL));
    }
    for (const m of p.messages)
      if (m.delivery.state !== "acknowledged")
        reserved += Math.max(0, CONTROL_BYTES - jsonBytes(m.delivery));
  }
  return bytes + reserved;
}
function historyKeys(s) {
  return new Set(
    s.pairs.flatMap((p) => [
      JSON.stringify([p.id]),
      ...p.requests.map((r) => JSON.stringify([p.id, "request", r.id])),
      ...p.messages.map((m) => JSON.stringify([p.id, "message", m.id])),
    ]),
  );
}
function checkCapacity(s, bytes, beforeCharge, keys) {
  const charge = capacityCharge(s, bytes);
  const retainsOnly = [...historyKeys(s)].every((key) => keys.has(key));
  if (
    bytes > SNAPSHOT_BYTES ||
    (charge > ADMISSION_BYTES && (!retainsOnly || charge > beforeCharge))
  ) {
    const closed = s.pairs.find((p) => p.closed);
    const action = closed
      ? `archive a closed pair with dotbabel peer archive --pair ${closed.id}`
      : "unpair a finished pair, then run dotbabel peer archive --pair ID";
    throw new Error(
      `peer repository capacity reached; ${action}; creating another pair does not free space`,
    );
  }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomicWrite(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function validateArchives(s) {
  if (s.archives === undefined) return;
  if (!Array.isArray(s.archives)) throw new Error("malformed peer archive catalog");
  const ids = new Set(s.pairs.map((p) => p.id));
  for (const a of s.archives) {
    if (
      !a ||
      typeof a.id !== "string" ||
      ids.has(a.id) ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      a.file !== `${a.sha256}.json` ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes <= 0 ||
      a.bytes > SNAPSHOT_BYTES
    )
      throw new Error("malformed peer archive catalog");
    ids.add(a.id);
  }
}

/** Repository-scoped JSON transactions with reserved recovery space and lossless closed-pair archives. */
export class PeerStore {
  /** @param {string} root private machine state directory @param {string} repo normalized Fleet repository identity */
  constructor(root, repo) {
    this.root = path.resolve(root);
    this.repo = repo;
    if (fs.existsSync(this.root)) {
      const stat = fs.lstatSync(this.root);
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink: ${this.root}`);
      if (process.getuid && stat.uid !== process.getuid())
        throw new Error("foreign state directory owner");
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    privatePath(this.root, true);
    this.file = path.join(this.root, `${createHash("sha256").update(repo).digest("hex")}.json`);
    this.lock = `${this.file}.lock`;
  }
  #snapshot() {
    privatePath(this.file);
    let text;
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).size > SNAPSHOT_BYTES)
          throw new Error("peer snapshot exceeds recovery capacity (48 MiB)");
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if (err.code === "ENOENT") return { state: createState(this.repo), text: null };
      throw new Error(`malformed or unreadable peer state: ${err.message}`);
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch (err) {
      throw new Error(`malformed or unreadable peer state: ${err.message}`);
    }
    validate(state, this.repo);
    validateArchives(state);
    return { state, text };
  }
  /** Read the live ledger and archive catalog without loading closed history. @returns {Promise<object>} */
  async read() {
    return this.#snapshot().state;
  }
  /** Read a live or archived pair, verifying archive identity and integrity. @param {string} id @returns {Promise<object>} */
  async readPair(id) {
    const state = await this.read();
    const live = state.pairs.find((p) => p.id === id);
    if (live) return live;
    const entry = state.archives?.find((a) => a.id === id);
    if (!entry) throw new Error("unknown peer pair");
    return this.#readArchive(entry);
  }
  #readArchive(entry) {
    const directory = path.join(this.root, "archives");
    privatePath(directory, true);
    const file = path.join(directory, entry.file);
    privatePath(file);
    let text;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).size !== entry.bytes) throw new Error("size mismatch");
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      if (createHash("sha256").update(text).digest("hex") !== entry.sha256)
        throw new Error("checksum mismatch");
      const state = JSON.parse(text);
      validate(state, this.repo);
      if (state.pairs.length !== 1 || state.pairs[0].id !== entry.id || !state.pairs[0].closed)
        throw new Error("identity mismatch");
      return state.pairs[0];
    } catch (err) {
      throw new Error(`unreadable peer archive: ${err.message}`);
    }
  }
  /** Archive one closed pair before atomically replacing its live entry with a reference. @param {string} id @returns {Promise<object>} */
  async archive(id) {
    return this.transaction((s) => {
      const existing = s.archives?.find((a) => a.id === id);
      if (existing) {
        this.#readArchive(existing);
        return { ...existing, path: path.join(this.root, "archives", existing.file) };
      }
      const matches = s.pairs.filter((p) => p.id === id);
      if (matches.length !== 1 || !matches[0].closed)
        throw new Error("archive requires one unique closed pair; unpair it first");
      const pair = matches[0];
      const text = JSON.stringify({ version: 1, repo: this.repo, pairs: [pair] }) + "\n";
      const sha256 = createHash("sha256").update(text).digest("hex");
      const directory = path.join(this.root, "archives");
      privatePath(directory, true);
      fs.mkdirSync(directory, { mode: 0o700, recursive: true });
      const entry = { id, file: `${sha256}.json`, sha256, bytes: Buffer.byteLength(text) };
      const file = path.join(directory, entry.file);
      privatePath(file);
      if (fs.existsSync(file)) this.#readArchive(entry);
      else atomicWrite(file, text);
      // Make the new directory entry durable before committing the catalog reference.
      syncDirectory(this.root);
      s.archives ??= [];
      s.archives.push(entry);
      s.pairs = s.pairs.filter((p) => p.id !== id);
      return { ...entry, path: file };
    });
  }
  /** Serialize a synchronous mutation and fsync its atomic replacement. @param {(state: object) => unknown} mutate @returns {Promise<any>} */
  async transaction(mutate) {
    let lock;
    const deadline = Date.now() + 5000;
    while (!lock?.acquired) {
      privatePath(this.lock, false, false);
      lock = acquireLock(this.lock, { resource: `peer:${this.repo}` });
      if (!lock.acquired) {
        if (Date.now() >= deadline)
          throw new Error(`peer transaction lock busy (${lock.reason}); retry later`);
        await delay(10 + Math.random() * 20);
      }
    }
    try {
      const { state, text: before } = this.#snapshot();
      const bytes = before === null ? jsonBytes(state) + 1 : Buffer.byteLength(before);
      const charge = capacityCharge(state, bytes);
      const keys = historyKeys(state);
      const result = mutate(state);
      if (result && typeof result.then === "function")
        throw new Error("peer transaction callbacks must be synchronous");
      validate(state, this.repo);
      validateArchives(state);
      const text = JSON.stringify(state) + "\n";
      if (text === before) return result;
      checkCapacity(state, Buffer.byteLength(text), charge, keys);
      atomicWrite(this.file, text);
      return result;
    } finally {
      lock.release();
    }
  }
}
