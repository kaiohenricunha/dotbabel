// The live Jev send. Only each locked request leaves the process, after fresh consent and a visibility check.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { jevAdapter, jevRequest } from "../../../plugins/dotbabel/src/jev-adapter.mjs";
import { requestPlan, validateLock } from "./protocol.mjs";

/** The repository visibility that GitHub reports now. */
export function githubVisibility(repo) {
  const result = spawnSync("gh", ["api", `repos/${repo}`, "--jq", ".visibility"], { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error("repository visibility check failed");
  return result.stdout.trim();
}

const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
export const usable = record => record?.fallback === false && Number.isFinite(record.confidence) && Array.isArray(record.answer);

/** Send each locked request that has no usable answer yet, and write all answers to `out`.
 * @param {string} lockFile
 * @param {string} out
 * @param {{consent?: string, key?: string, fetch?: typeof globalThis.fetch, visibility?: (repo: string) => string, resume?: boolean, timeoutMs?: number}} opts
 */
export async function sendPlan(lockFile, out, { consent, key, fetch = globalThis.fetch, visibility = githubVisibility, resume = false, timeoutMs = 30000 } = {}) {
  const lock = validateLock(lockFile);
  if (!consent || consent !== lock.repository) throw new Error("fresh send consent for the locked repository required");
  if (!key) throw new Error("TYPESAFE_API_KEY is required for send");
  if (fs.existsSync(out) && !resume) throw new Error("output must be new; use --resume to continue");
  if (!fs.existsSync(out) && resume) throw new Error("nothing to resume");
  const plan = requestPlan(lockFile, lock.repository), byId = new Map(lock.rows.map(r => [r.id, r]));
  const previous = new Map(resume ? lines(out).map(r => [r.id, r]) : []);
  if (resume && [...previous.values()].some(r => r.protocol_hash !== lock.protocol_hash || r.lock_sha256 !== lock.lock_sha256)) throw new Error("answers belong to another lock");
  if (visibility(lock.repository) !== "public") throw new Error("the locked repository is not public now");
  const adapter = jevAdapter(key, { fetch });
  const records = [];
  let sent = 0, failed = 0;
  for (const entry of plan) {
    const row = byId.get(entry.id);
    if (usable(previous.get(entry.id))) { records.push(previous.get(entry.id)); continue; }
    // The adapter rebuilds the payload from the locked input; it must equal the planned request byte for byte.
    if (JSON.stringify(jevRequest(row.step, row.input)) !== JSON.stringify(entry.request)) throw new Error("request differs from the locked plan");
    const base = { id: entry.id, protocol_hash: entry.protocol_hash, lock_sha256: entry.lock_sha256, sample_hash: entry.sample_hash };
    sent++;
    try {
      const answer = await adapter(row.step, row.input, { signal: AbortSignal.timeout(timeoutMs) });
      records.push({ ...base, answer: answer.answer, confidence: answer.confidence, fallback: false, answered_at: new Date().toISOString() });
    } catch {
      failed++;
      records.push({ ...base, fallback: true, error: "request failed", answered_at: new Date().toISOString() });
    }
  }
  const temp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(temp, records.map(r => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, out);
  return { sent, failed, answered: records.filter(usable).length, requests: plan.length, out };
}
