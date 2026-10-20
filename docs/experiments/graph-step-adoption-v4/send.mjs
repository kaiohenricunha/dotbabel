// The live Jev send for retry. Only each locked request leaves the process, after fresh consent and visibility checks.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { jevAdapter } from "../../../plugins/dotbabel/src/jev-adapter.mjs";
import { githubVisibility } from "../graph-step-adoption-v3/send.mjs";
import { planFor, validateLock } from "./protocol.mjs";
import { validAnswer } from "./analysis.mjs";

const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);

/** Send each locked request that has no usable answer yet. Each record is appended as it arrives, so an
 * interruption keeps the paid answers; at the end the file is compacted to the latest record per row.
 * `consent` must equal the lock's `repositories_sha256`, so the owner names the exact repository set.
 * @param {string} lockFile
 * @param {string} out
 * @param {{consent?: string, key?: string, fetch?: typeof globalThis.fetch, visibility?: (repo: string) => string, resume?: boolean, timeoutMs?: number}} opts
 */
export async function sendPlan(lockFile, out, { consent, key, fetch = globalThis.fetch, visibility = githubVisibility, resume = false, timeoutMs = 30000 } = {}) {
  const lock = validateLock(lockFile);
  if (!consent || consent !== lock.repositories_sha256) throw new Error("fresh send consent for the locked repository set required");
  if (!key) throw new Error("TYPESAFE_API_KEY is required for send");
  if (!resume && fs.existsSync(out)) throw new Error("output must be new; use --resume to continue");
  if (resume && !fs.existsSync(out)) throw new Error("nothing to resume");
  const plan = planFor(lock), byId = new Map(lock.rows.map(r => [r.id, r]));
  const latest = new Map();
  for (const record of resume ? lines(out) : []) {
    if (!byId.has(record.id) || record.protocol_hash !== lock.protocol_hash || record.lock_sha256 !== lock.lock_sha256) throw new Error("answers belong to another lock");
    latest.set(record.id, record);
  }
  const pending = plan.filter(entry => !validAnswer(lock, byId.get(entry.id), latest.get(entry.id)));
  for (const repo of new Set(pending.map(entry => byId.get(entry.id).repo))) {
    if (visibility(repo) !== "public") throw new Error("a locked repository is not public now");
  }
  // The adapter builds its own body; the real bytes on the wire must equal the planned request.
  let expected = null, mismatch = false;
  const guarded = (url, init) => {
    if (init?.body !== expected) { mismatch = true; throw new Error("request differs from the locked plan"); }
    return fetch(url, init);
  };
  const adapter = jevAdapter(key, { fetch: guarded });
  // "wx" makes the first create exclusive, so two runs cannot share one output.
  const fd = fs.openSync(out, resume ? "a" : "wx", 0o600);
  let sent = 0, failed = 0;
  try {
    for (const entry of pending) {
      const row = byId.get(entry.id);
      expected = JSON.stringify(entry.request);
      const base = { id: entry.id, protocol_hash: entry.protocol_hash, lock_sha256: entry.lock_sha256, sample_hash: entry.sample_hash };
      let record;
      sent++;
      try {
        const answer = await adapter(row.step, row.input, { signal: AbortSignal.timeout(timeoutMs) });
        record = { ...base, answer: answer.answer, confidence: answer.confidence, fallback: false, answered_at: new Date().toISOString() };
      } catch {
        if (mismatch) throw new Error("request differs from the locked plan");
        failed++;
        record = { ...base, fallback: true, error: "request failed", answered_at: new Date().toISOString() };
      }
      fs.writeSync(fd, JSON.stringify(record) + "\n");
      latest.set(entry.id, record);
    }
  } finally { fs.closeSync(fd); }
  const records = plan.map(entry => latest.get(entry.id)).filter(Boolean);
  const temp = `${out}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, records.map(r => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, out);
  } finally { fs.rmSync(temp, { force: true }); }
  const answered = plan.filter(entry => validAnswer(lock, byId.get(entry.id), latest.get(entry.id))).length;
  return { sent, failed, answered, requests: plan.length, out };
}
