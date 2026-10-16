/** Crash-safe private repository state, using Dotbabel's existing process-incarnation lock. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock } from "../lib/process-lock.mjs";
import { createState } from "./state.mjs";

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
      !p.main?.key
    )
      throw new Error("malformed peer pair");
    for (const m of p.messages)
      if (
        m.version !== 1 ||
        m.pair_id !== p.id ||
        typeof m.body !== "string" ||
        !m.delivery ||
        typeof m.to !== "string"
      )
        throw new Error("malformed peer message");
    for (const r of p.requests)
      if (typeof r.id !== "string" || typeof r.body !== "string" || typeof r.state !== "string")
        throw new Error("malformed peer request");
  }
}

/** Repository-scoped JSON transactions. No model context or credentials are stored. */
export class PeerStore {
  /** @param {string} root private machine state directory @param {string} repo normalized Fleet repository identity */
  constructor(root, repo) {
    this.root = path.resolve(root);
    this.repo = repo;
    // The caller may use a freshly-created 0755 directory. Tighten it once, but
    // never follow a root symlink or change a foreign user's directory.
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
  /** Read a complete snapshot; corrupt data is never silently replaced. @returns {Promise<object>} */
  async read() {
    privatePath(this.file);
    let s;
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).size > 32 * 1024 * 1024) throw new Error("peer state exceeds 32 MiB");
        s = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if (err.code === "ENOENT") return createState(this.repo);
      throw new Error(`malformed or unreadable peer state: ${err.message}`);
    }
    validate(s, this.repo);
    return s;
  }
  /** Serialize a synchronous mutation and fsync the atomic replacement. @param {(state: object) => unknown} mutate @returns {Promise<any>} */
  async transaction(mutate) {
    let lock;
    const deadline = Date.now() + 5000;
    while (!lock?.acquired) {
      // The shared lock uses the process umask; the enclosing directory is 0700.
      privatePath(this.lock, false, false);
      lock = acquireLock(this.lock, { resource: `peer:${this.repo}` });
      if (!lock.acquired) {
        if (Date.now() >= deadline)
          throw new Error(`peer transaction lock busy (${lock.reason}); retry later`);
        await delay(10 + Math.random() * 20);
      }
    }
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const s = await this.read();
      const before = JSON.stringify(s);
      const result = mutate(s);
      if (result && typeof result.then === "function")
        throw new Error("peer transaction callbacks must be synchronous");
      validate(s, this.repo);
      const after = JSON.stringify(s);
      if (before === after && fs.existsSync(this.file)) return result;
      const text = after + "\n";
      if (Buffer.byteLength(text) > 32 * 1024 * 1024)
        throw new Error("peer history limit (32 MiB); create a new pair");
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      const dir = fs.openSync(this.root, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
      return result;
    } finally {
      fs.rmSync(tmp, { force: true });
      lock.release();
    }
  }
}
