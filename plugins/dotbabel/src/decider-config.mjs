/** Repository consent and user credentials. No network; never prints a key. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DECISION_STEPS } from "./decision-value.mjs";
import { resolveMaxAttempts } from "./pr-gates.mjs";

function git(cwd, args) {
  const out = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000 });
  return out.status === 0 ? out.stdout.trim() : null;
}

/** Read the working config and committed consent independently.
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{root: string, config: object, consentSteps: string[], key: string}}
 */
export function deciderContext(cwd = process.cwd(), env = process.env) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("decider requires a git repository");
  const file = path.join(root, ".dotbabel.json");
  let config;
  try { config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; }
  catch { throw new Error("cannot read .dotbabel.json"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid .dotbabel.json");
  const decider = config.decider ?? { adapter: "builtin", steps: DECISION_STEPS };
  if (!decider || typeof decider !== "object" || Array.isArray(decider) || Object.keys(decider).some((k) => !["adapter", "steps"].includes(k)) || !["builtin", "jev"].includes(decider.adapter) || !Array.isArray(decider.steps) || new Set(decider.steps).size !== decider.steps.length || !decider.steps.every((s) => DECISION_STEPS.includes(s))) throw new Error("invalid decider configuration");
  let committed = null;
  try { committed = JSON.parse(git(root, ["show", "HEAD:.dotbabel.json"]) ?? "null")?.decider; } catch { /* No committed consent. */ }
  const consentSteps = decider.adapter === "jev" && committed?.adapter === "jev" && Array.isArray(committed.steps) ? decider.steps.filter((s) => committed.steps.includes(s)) : [];
  return { root, config: { ...decider }, consentSteps, key: env.TYPESAFE_API_KEY ?? "" };
}

/** Doctor's safe status: credential presence, never its content.
 * @param {ReturnType<typeof deciderContext>} context
 * @returns {string}
 */
export function describeDecider(context) {
  return `decider: adapter ${context.config.adapter}, consent ${context.consentSteps.length ? context.consentSteps.join(",") : "none"}, key ${context.key ? "present" : "absent"}; unadopted steps remain in shadow mode`;
}

/** Resolve the retry limit from a committed base, without a network call.
 * @param {string} root
 * @param {string} phase
 * @param {string} [baseRef]
 * @returns {number}
 */
export function decisionAttemptCap(root, phase, baseRef) {
  const ref = baseRef ?? git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]) ?? (git(root, ["rev-parse", "--verify", "origin/main"]) ? "origin/main" : "HEAD");
  if (!git(root, ["rev-parse", "--verify", `${ref}^{commit}`])) throw new Error("retry base ref is unavailable");
  const raw = git(root, ["show", `${ref}:.dotbabel.json`]);
  let config = {};
  if (raw !== null) {
    try { config = JSON.parse(raw); } catch { throw new Error("retry base configuration is invalid"); }
  }
  try { return resolveMaxAttempts(config, phase); }
  catch { throw new Error("retry base conductor configuration is invalid"); }
}
