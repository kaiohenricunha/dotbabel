import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { redactOutput } from "../lib/redact-output.mjs";
import { isRepoTrusted } from "../trust-allowlist.mjs";

const MAX_OUTPUT = 1024 * 1024;
const ENV_NAMES = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "HOME", "USERPROFILE", "GOPATH", "GOROOT", "GOMODCACHE", "GOCACHE", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "VIRTUAL_ENV"];

function inside(root, candidate) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function executionError(message) {
  return new ValidationError({ code: ERROR_CODES.QUALITY_EXECUTION_FAILED, category: "quality", message });
}

/** Validate a command plan before execution. */
export function validateCommandPlan({ repoRoot, plan }) {
  if (typeof plan.executable !== "string" || plan.executable.length === 0 || plan.executable.includes("\0")) throw executionError("command executable must be a safe string");
  if (path.isAbsolute(plan.executable) && plan.executable !== process.execPath) throw executionError("absolute executable paths are not permitted");
  if (!path.isAbsolute(plan.executable) && plan.executable.includes("/") && !plan.executable.startsWith("./")) throw executionError("configured executables must be PATH names or repository-relative './' paths");
  if (!Array.isArray(plan.argv) || plan.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw executionError("command argv must contain safe strings");
  if (!fs.existsSync(plan.cwd) || !inside(repoRoot, plan.cwd)) throw executionError("command cwd must stay inside the repository");
  if (plan.executable.startsWith("./")) {
    const executable = path.resolve(plan.cwd, plan.executable);
    if (!fs.existsSync(executable) || !inside(repoRoot, executable)) throw executionError("repository executable escapes the repository");
  }
  return plan;
}

function childEnvironment(passEnv, environment) {
  const result = {};
  for (const name of [...ENV_NAMES, ...passEnv]) if (environment[name] !== undefined) result[name] = environment[name];
  return result;
}

function runOne(plan, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let spawnError;
    const child = spawn(plan.executable, plan.argv, {
      cwd: plan.cwd,
      env: childEnvironment(options.passEnv, options.env),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    function append(current, chunk) {
      if (current.length >= MAX_OUTPUT) { truncated = true; return current; }
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT) { truncated = true; return next.slice(0, MAX_OUTPUT); }
      return next;
    }
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => { spawnError = error; });
    const timeoutSeconds = plan.timeoutSeconds ?? options.timeoutSeconds;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill("SIGTERM");
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000).unref();
    }, timeoutSeconds * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        id: plan.id,
        componentId: plan.componentId,
        capability: plan.capability,
        capabilities: plan.capabilities,
        ruleIds: plan.ruleIds,
        state: spawnError ? "unavailable" : "checked",
        exitCode: spawnError ? null : code,
        signal,
        timedOut,
        truncated,
        stdout: redactOutput(stdout),
        stderr: redactOutput(spawnError?.message ? `${stderr}\n${spawnError.message}` : stderr),
        durationMs: Date.now() - started,
        report: plan.report,
        reports: plan.reports,
        stdoutFailure: plan.stdoutFailure === true,
      });
    });
  });
}

/** Execute validated plans with per-component serialization and bounded concurrency. */
export async function runQualityPlans({ repoRoot, plans, allowProjectCommands = false, passEnv = [], env = process.env, jobs = 2, timeoutSeconds = 120 } = {}) {
  if (passEnv.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw executionError("--pass-env names must be valid environment variable names");
  const trust = isRepoTrusted({ repoRoot, env });
  const pending = plans.filter((plan) => plan.executable && ["available", "candidate"].includes(plan.availability));
  const results = plans.filter((plan) => !pending.includes(plan)).map((plan) => ({ id: plan.id, componentId: plan.componentId, capability: plan.capability, ruleIds: plan.ruleIds, state: plan.availability ?? "not_configured", candidates: plan.candidates, evidence: plan.evidence }));
  const byCommand = new Map();
  for (const plan of pending) {
    const key = `${plan.cwd}\0${plan.executable}\0${plan.argv.join("\0")}`;
    const previous = byCommand.get(key);
    if (!previous) {
      byCommand.set(key, { ...plan, capabilities: [plan.capability], ruleIds: [...(plan.ruleIds ?? [])], reports: plan.report ? [plan.report] : [] });
      continue;
    }
    previous.ruleIds = [...new Set([...previous.ruleIds, ...(plan.ruleIds ?? [])])];
    previous.capabilities = [...new Set([...previous.capabilities, plan.capability])];
    if (plan.report && !previous.reports.some((item) => JSON.stringify(item) === JSON.stringify(plan.report))) previous.reports.push(plan.report);
    previous.stdoutFailure ||= plan.stdoutFailure === true;
  }
  const unique = [...byCommand.values()];
  for (const plan of unique) {
    validateCommandPlan({ repoRoot, plan });
    if (plan.requiresTrust && !allowProjectCommands && !trust.trusted) throw new ValidationError({ code: ERROR_CODES.QUALITY_TRUST_REQUIRED, category: "quality", message: `project-command trust is required for ${plan.id}`, hint: "trust the exact repository path or pass --allow-project-commands in CI" });
  }
  const grouped = new Map();
  for (const plan of unique) {
    if (!grouped.has(plan.componentId)) grouped.set(plan.componentId, []);
    grouped.get(plan.componentId).push(plan);
  }
  const groups = [...grouped.values()];
  let next = 0;
  async function worker() {
    while (next < groups.length) {
      const group = groups[next++];
      for (const plan of group) results.push(await runOne(plan, { passEnv, env, timeoutSeconds }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), 8, groups.length || 1) }, worker));
  return results;
}
