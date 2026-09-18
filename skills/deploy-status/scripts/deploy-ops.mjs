#!/usr/bin/env node
/**
 * deploy-ops.mjs
 *
 * Shared implementation for the deploy-status and rollback-prod skills.
 * The public contract is the skill workflow; this file keeps platform
 * discovery and provider adapters testable.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = {
  OK: 0,
  DRIFT: 1,
  TARGET_FAILURE: 2,
  USAGE: 64,
};

const SUPPORTED_KINDS = new Set(["vercel", "fly", "aws-amplify"]);
const SHA_RE = /\b[0-9a-f]{7,40}\b/i;

/**
 * Parse the argv shape used by both skills.
 *
 * @param {string[]} argv
 * @returns {{ command: string, flags: Record<string, string|boolean> }}
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[rawKey] = argv[++i];
    } else {
      flags[rawKey] = true;
    }
  }
  return { command: positional[0] ?? "status", flags };
}

/**
 * Run a command and return stdout/stderr without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error?: Error }}
 */
export function runSync(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * Run a command asynchronously.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ ok: boolean, status: number|null, stdout: string, stderr: string, error?: Error }>}
 */
export function runAsync(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ ok: false, status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      resolve({ ok: status === 0, status, stdout, stderr });
    });
  });
}

/**
 * Resolve the repository root for the consuming project.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveProjectRoot(cwd = process.cwd()) {
  const git = runSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  if (git.ok && git.stdout.trim()) return git.stdout.trim();
  return cwd;
}

/**
 * Parse JSON with a useful file label in the thrown error.
 *
 * @param {string} text
 * @param {string} label
 * @returns {any}
 */
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: invalid JSON (${err.message})`);
  }
}

/**
 * Load optional .claude/deploy-targets.json.
 *
 * @param {string} root
 * @returns {{ targets: object[], rollback_order: string[] }}
 */
export function loadDeployConfig(root) {
  const configPath = path.join(root, ".claude", "deploy-targets.json");
  if (!existsSync(configPath)) return { targets: [], rollback_order: [] };
  const parsed = parseJson(readFileSync(configPath, "utf8"), configPath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.targets)) {
    throw new Error(`${configPath}: expected { "targets": [...] }`);
  }
  const rollbackOrder = Array.isArray(parsed.rollback_order)
    ? parsed.rollback_order.filter((v) => typeof v === "string" && v.trim())
    : [];
  return { targets: parsed.targets, rollback_order: rollbackOrder };
}

/**
 * Parse just the top-level Fly app from fly.toml.
 *
 * @param {string} toml
 * @returns {string|null}
 */
export function parseFlyApp(toml) {
  for (const line of toml.split(/\r?\n/)) {
    const match = line.match(/^\s*app\s*=\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Discover deploy targets from well-known provider files.
 *
 * @param {string} root
 * @returns {object[]}
 */
export function discoverTargets(root) {
  const targets = [];

  const vercelProjectPath = path.join(root, ".vercel", "project.json");
  if (existsSync(vercelProjectPath)) {
    const parsed = parseJson(readFileSync(vercelProjectPath, "utf8"), vercelProjectPath);
    if (parsed.projectId || parsed.projectName) {
      targets.push({
        kind: "vercel",
        id: `vercel/${parsed.projectName ?? parsed.projectId}`,
        project: parsed.projectName ?? parsed.projectId,
        projectId: parsed.projectId,
        orgId: parsed.orgId,
        source: "auto",
      });
    }
  }

  const flyPath = path.join(root, "fly.toml");
  if (existsSync(flyPath)) {
    const app = parseFlyApp(readFileSync(flyPath, "utf8"));
    if (app) {
      targets.push({
        kind: "fly",
        id: `fly/${app}`,
        app,
        source: "auto",
      });
    }
  }

  return targets;
}

/**
 * Normalize a user or auto target into the internal shape.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeTarget(raw) {
  const kind = String(raw?.kind ?? "").trim();
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new Error(`unsupported deploy target kind: ${kind || "(missing)"}`);
  }

  if (kind === "vercel") {
    const project = raw.project ?? raw.projectName ?? raw.projectId;
    if (!project) throw new Error("vercel target requires project, projectName, or projectId");
    return {
      ...raw,
      kind,
      project: String(project),
      projectId: raw.projectId ? String(raw.projectId) : undefined,
      team: raw.team ?? raw.teamId ?? raw.orgId,
      scope: raw.scope ?? raw.teamSlug,
      id: raw.id ?? `vercel/${raw.projectName ?? project}`,
    };
  }

  if (kind === "fly") {
    if (!raw.app) throw new Error("fly target requires app");
    return {
      ...raw,
      kind,
      app: String(raw.app),
      id: raw.id ?? `fly/${raw.app}`,
    };
  }

  return {
    ...raw,
    kind,
    id: raw.id ?? `${kind}/${raw.appId ?? raw.app ?? raw.project ?? "default"}`,
  };
}

/**
 * Build the final target list from discovery plus config overrides.
 *
 * @param {string} root
 * @returns {{ targets: object[], rollbackOrder: string[] }}
 */
export function resolveTargets(root) {
  const config = loadDeployConfig(root);
  const merged = new Map();
  for (const target of discoverTargets(root).map(normalizeTarget)) {
    merged.set(targetKey(target), target);
  }
  for (const raw of config.targets) {
    const target = normalizeTarget(raw);
    const key = targetKey(target);
    merged.set(key, { ...(merged.get(key) ?? {}), ...target, source: "config" });
  }
  return { targets: [...merged.values()], rollbackOrder: config.rollback_order };
}

/**
 * Stable identity for merging auto-discovered and configured targets.
 *
 * @param {object} target
 * @returns {string}
 */
export function targetKey(target) {
  if (target.kind === "vercel") return `vercel/${target.projectId ?? target.project}`;
  if (target.kind === "fly") return `fly/${target.app}`;
  return `${target.kind}/${target.id}`;
}

/**
 * Human label for tables.
 *
 * @param {object} target
 * @returns {string}
 */
export function targetLabel(target) {
  if (target.kind === "vercel") return `vercel/${target.project}`;
  if (target.kind === "fly") return `fly/${target.app}`;
  return target.id ?? target.kind;
}

/**
 * Resolve origin/main and fetch it first unless skipped.
 *
 * @param {string} root
 * @param {{ noFetch?: boolean }} [opts]
 * @returns {string}
 */
export function resolveOriginMain(root, opts = {}) {
  if (!opts.noFetch) {
    const fetch = runSync("git", ["fetch", "origin", "main", "--quiet"], {
      cwd: root,
      timeoutMs: 120_000,
    });
    if (!fetch.ok) {
      throw new Error(`git fetch origin main failed: ${commandError(fetch)}`);
    }
  }
  const rev = runSync("git", ["rev-parse", "origin/main"], { cwd: root, timeoutMs: 10_000 });
  if (!rev.ok || !rev.stdout.trim()) {
    throw new Error(`git rev-parse origin/main failed: ${commandError(rev)}`);
  }
  return rev.stdout.trim();
}

/**
 * Compare a deployed SHA against origin/main.
 *
 * @param {string|null} deployedSha
 * @param {string} mainSha
 * @param {string} root
 * @returns {{ text: string, drift: boolean, unknown: boolean }}
 */
export function compareToMain(deployedSha, mainSha, root) {
  if (!deployedSha) return { text: "unknown SHA", drift: true, unknown: true };
  const full = deployedSha.trim();
  if (mainSha.startsWith(full) || full.startsWith(mainSha)) {
    return { text: "in sync", drift: false, unknown: false };
  }
  const revList = runSync("git", ["rev-list", "--left-right", "--count", `${full}...${mainSha}`], {
    cwd: root,
    timeoutMs: 10_000,
  });
  if (!revList.ok) {
    return { text: "unknown (SHA not found on origin/main)", drift: true, unknown: true };
  }
  const [aheadRaw, behindRaw] = revList.stdout.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (ahead === 0 && behind === 0) return { text: "in sync", drift: false, unknown: false };
  if (behind > 0 && ahead === 0) {
    return {
      text: `${behind} commit${behind === 1 ? "" : "s"} behind`,
      drift: true,
      unknown: false,
    };
  }
  if (ahead > 0 && behind === 0) {
    return { text: `${ahead} commit${ahead === 1 ? "" : "s"} ahead`, drift: true, unknown: false };
  }
  return {
    text: `${behind} behind, ${ahead} ahead`,
    drift: true,
    unknown: false,
  };
}

/**
 * Extract a likely git SHA from a nested provider object.
 *
 * @param {any} value
 * @returns {string|null}
 */
export function extractSha(value) {
  const preferred = [];
  const fallback = [];

  function visit(node, key = "") {
    if (node == null) return;
    if (typeof node === "string" || typeof node === "number") {
      const str = String(node);
      const match = str.match(SHA_RE);
      if (!match) return;
      if (/git|commit|sha|revision/i.test(key)) preferred.push(match[0]);
      else fallback.push(match[0]);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (typeof node === "object") {
      for (const [childKey, childValue] of Object.entries(node)) {
        visit(childValue, childKey);
      }
    }
  }

  visit(value);
  return preferred[0] ?? fallback[0] ?? null;
}

/**
 * Create rollback execution groups from rollback_order.
 *
 * @param {object[]} targets
 * @param {string[]} rollbackOrder
 * @returns {object[][]}
 */
export function buildRollbackGroups(targets, rollbackOrder) {
  if (!rollbackOrder.length) return [targets];
  const remaining = new Set(targets);
  const groups = [];
  for (const token of rollbackOrder) {
    const group = targets.filter(
      (target) => remaining.has(target) && targetMatchesOrder(target, token),
    );
    for (const target of group) remaining.delete(target);
    if (group.length) groups.push(group);
  }
  if (remaining.size) groups.push([...remaining]);
  return groups;
}

/**
 * @param {object} target
 * @param {string} token
 * @returns {boolean}
 */
function targetMatchesOrder(target, token) {
  const normalized = token.toLowerCase();
  return [
    target.id,
    target.kind,
    targetKey(target),
    targetLabel(target),
    target.app,
    target.project,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .includes(normalized);
}

/**
 * Format a table with padded columns.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function formatTable(headers, rows) {
  const widths = headers.map((header, idx) =>
    Math.max(header.length, ...rows.map((row) => String(row[idx] ?? "").length)),
  );
  const formatRow = (row) =>
    row.map((cell, idx) => String(cell ?? "").padEnd(widths[idx])).join("  ");
  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(formatRow),
  ].join("\n");
}

/**
 * @param {string|null|undefined} sha
 * @returns {string}
 */
export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "unknown";
}

/**
 * @param {string|number|Date|null|undefined} timestamp
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatAge(timestamp, nowMs = Date.now()) {
  const date = timestamp ? new Date(timestamp) : null;
  const ms = date && !Number.isNaN(date.getTime()) ? Math.max(0, nowMs - date.getTime()) : null;
  if (ms == null) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 48) return `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * @param {{ stdout?: string, stderr?: string, error?: Error, status?: number|null }} result
 * @returns {string}
 */
export function commandError(result) {
  return (
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    result.error?.message ||
    `exit ${result.status ?? "unknown"}`
  );
}

/**
 * Try to parse a provider JSON payload that may be an array or envelope.
 *
 * @param {string} text
 * @param {string[]} arrayKeys
 * @returns {any[]}
 */
export function parseJsonArray(text, arrayKeys) {
  const parsed = parseJson(text, "provider output");
  if (Array.isArray(parsed)) return parsed;
  for (const key of arrayKeys) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
}

/**
 * @param {any} value
 * @param {string[]} keys
 * @returns {any}
 */
function pick(value, keys) {
  for (const key of keys) {
    if (value?.[key] != null && value[key] !== "") return value[key];
  }
  return undefined;
}

/**
 * @param {object} target
 * @returns {string[]}
 */
function vercelScopeArgs(target) {
  const scope =
    target.scope ?? (target.team && !String(target.team).startsWith("team_") ? target.team : null);
  return scope ? ["--scope", String(scope)] : [];
}

const vercelAdapter = {
  kind: "vercel",

  auth(target, ctx) {
    const result = runSync("vercel", ["whoami", "--cwd", ctx.root, ...vercelScopeArgs(target)], {
      cwd: ctx.root,
      timeoutMs: 60_000,
    });
    if (!result.ok) throw new Error(`vercel auth failed: ${commandError(result)}`);
  },

  releases(target, ctx) {
    const listArgs = [
      "list",
      target.project,
      "--environment",
      "production",
      "--status",
      "READY",
      "--format",
      "json",
      "--yes",
      "--cwd",
      ctx.root,
      ...vercelScopeArgs(target),
    ];
    const result = runSync("vercel", listArgs, { cwd: ctx.root, timeoutMs: 120_000 });
    if (!result.ok) throw new Error(`vercel list failed: ${commandError(result)}`);
    const deployments = parseJsonArray(result.stdout, ["deployments", "items"]).slice(0, 5);
    if (!deployments.length)
      throw new Error("vercel list returned no production READY deployments");
    return deployments.map((deployment) => inspectVercelDeployment(target, deployment, ctx));
  },

  async rollback(target, release, ctx) {
    const deploymentRef = release.rollbackRef ?? release.url ?? release.id;
    if (!deploymentRef) throw new Error("vercel rollback requires a deployment id or url");
    const args = [
      "rollback",
      String(deploymentRef),
      "--yes",
      "--timeout",
      "5m",
      "--cwd",
      ctx.root,
      ...vercelScopeArgs(target),
    ];
    const result = await runAsync("vercel", args, { cwd: ctx.root });
    if (!result.ok) throw new Error(`vercel rollback failed: ${commandError(result)}`);
    return result;
  },
};

/**
 * @param {object} target
 * @param {object} deployment
 * @param {{ root: string }} ctx
 * @returns {object}
 */
function inspectVercelDeployment(target, deployment, ctx) {
  const ref = pick(deployment, ["uid", "id", "url", "name"]);
  let detail = deployment;
  if (ref) {
    const inspect = runSync(
      "vercel",
      ["inspect", String(ref), "--format", "json", "--cwd", ctx.root, ...vercelScopeArgs(target)],
      { cwd: ctx.root, timeoutMs: 120_000 },
    );
    if (inspect.ok) {
      try {
        detail = { ...deployment, ...JSON.parse(inspect.stdout) };
      } catch {
        detail = deployment;
      }
    }
  }
  return {
    target,
    id: pick(detail, ["uid", "id"]),
    url: pick(detail, ["url", "name"]),
    rollbackRef: pick(detail, ["uid", "id", "url", "name"]),
    sha: extractSha(detail),
    deployedAt: pick(detail, ["ready", "readyAt", "created", "createdAt", "buildingAt"]),
    deployer: extractDeployer(detail),
    raw: detail,
  };
}

/**
 * @returns {string}
 */
function resolveFlyCli() {
  for (const candidate of ["flyctl", "fly"]) {
    const result = runSync(candidate, ["version"], { timeoutMs: 10_000 });
    if (!result.error) return candidate;
  }
  return "flyctl";
}

const flyAdapter = {
  kind: "fly",

  auth(_target, ctx) {
    const cli = ctx.flyCli ?? resolveFlyCli();
    const result = runSync(cli, ["auth", "whoami"], { cwd: ctx.root, timeoutMs: 60_000 });
    if (!result.ok) throw new Error(`${cli} auth failed: ${commandError(result)}`);
  },

  releases(target, ctx) {
    const cli = ctx.flyCli ?? resolveFlyCli();
    const withImage = runSync(cli, ["releases", "--image", "--app", target.app, "--json"], {
      cwd: ctx.root,
      timeoutMs: 120_000,
    });
    const result = withImage.ok
      ? withImage
      : runSync(cli, ["releases", "--app", target.app, "--json"], {
          cwd: ctx.root,
          timeoutMs: 120_000,
        });
    if (!result.ok) throw new Error(`${cli} releases failed: ${commandError(result)}`);
    const releases = parseJsonArray(result.stdout, ["releases", "items"])
      .filter(isSuccessfulFlyRelease)
      .slice(0, 5);
    if (!releases.length) throw new Error(`${cli} releases returned no successful releases`);
    return releases.map((release) => normalizeFlyRelease(target, release));
  },

  async rollback(target, release, ctx) {
    const cli = ctx.flyCli ?? resolveFlyCli();
    const image = release.image;
    if (!image) {
      throw new Error("fly rollback requires an image from `fly releases --image --json`");
    }
    const args = ["deploy", "--app", target.app, "--image", image, "--yes"];
    const result = await runAsync(cli, args, { cwd: ctx.root });
    if (!result.ok)
      throw new Error(`${cli} deploy --image rollback failed: ${commandError(result)}`);
    return result;
  },
};

/**
 * @param {any} release
 * @returns {boolean}
 */
function isSuccessfulFlyRelease(release) {
  const status = String(pick(release, ["status", "Status", "state", "State"]) ?? "").toLowerCase();
  if (!status) return true;
  return /success|succeeded|complete|completed/.test(status);
}

/**
 * @param {object} target
 * @param {object} release
 * @returns {object}
 */
function normalizeFlyRelease(target, release) {
  return {
    target,
    id: pick(release, ["id", "ID", "version", "Version"]),
    version: pick(release, ["version", "Version"]),
    sha: extractSha(release),
    image: pick(release, [
      "image",
      "Image",
      "image_ref",
      "ImageRef",
      "docker_image",
      "DockerImage",
    ]),
    deployedAt: pick(release, ["created_at", "CreatedAt", "date", "Date", "createdAt"]),
    deployer: extractDeployer(release),
    raw: release,
  };
}

const unsupportedAdapter = {
  kind: "aws-amplify",
  auth() {
    throw new Error("aws-amplify deploy targets are documented stubs in this version");
  },
  releases() {
    throw new Error("aws-amplify deploy targets are documented stubs in this version");
  },
  async rollback() {
    throw new Error("aws-amplify deploy targets are documented stubs in this version");
  },
};

export const adapters = {
  vercel: vercelAdapter,
  fly: flyAdapter,
  "aws-amplify": unsupportedAdapter,
};

/**
 * @param {any} value
 * @returns {string}
 */
function extractDeployer(value) {
  const direct = pick(value, [
    "deployer",
    "deployerEmail",
    "user",
    "User",
    "created_by",
    "createdBy",
    "creator",
    "owner",
  ]);
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    return pick(direct, ["email", "username", "name", "uid", "id"]) ?? JSON.stringify(direct);
  }
  return "-";
}

/**
 * @param {{ root: string, targets: object[], noFetch?: boolean, dryRun?: boolean }} opts
 * @returns {{ exitCode: number, text: string }}
 */
export function statusReport(opts) {
  const { root, targets, noFetch = false, dryRun = false } = opts;
  if (!targets.length) {
    return { exitCode: EXIT.TARGET_FAILURE, text: "No deploy targets discovered or configured." };
  }
  if (dryRun) {
    const rows = targets.map((target) => [
      targetLabel(target),
      target.source ?? "-",
      target.kind === "vercel" ? target.project : (target.app ?? "-"),
      "dry-run",
    ]);
    return {
      exitCode: EXIT.OK,
      text: formatTable(["Target", "Source", "Identifier", "Action"], rows),
    };
  }

  let mainSha;
  try {
    mainSha = resolveOriginMain(root, { noFetch });
  } catch (err) {
    return { exitCode: EXIT.TARGET_FAILURE, text: err.message };
  }

  const rows = [];
  const errors = [];
  let hasDrift = false;
  let hasUnknown = false;

  const flyCli = resolveFlyCli();
  for (const target of targets) {
    const adapter = adapters[target.kind];
    try {
      adapter.auth(target, { root, flyCli });
      const [current] = adapter.releases(target, { root, flyCli });
      const drift = compareToMain(current.sha, mainSha, root);
      hasDrift ||= drift.drift;
      hasUnknown ||= drift.unknown;
      rows.push([
        targetLabel(target),
        shortSha(current.sha),
        formatAge(current.deployedAt),
        current.deployer ?? "-",
        drift.text,
      ]);
    } catch (err) {
      hasUnknown = true;
      errors.push(`${targetLabel(target)}: ${err.message}`);
      rows.push([targetLabel(target), "error", "-", "-", "target error"]);
    }
  }

  rows.push(["origin/main", shortSha(mainSha), "-", "-", "-"]);
  const text = [
    formatTable(["Target", "Deployed SHA", "Age", "Deployer", "Drift vs main"], rows),
    errors.length ? `\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    exitCode: errors.length || hasUnknown ? EXIT.TARGET_FAILURE : hasDrift ? EXIT.DRIFT : EXIT.OK,
    text,
  };
}

/**
 * @param {{ root: string, targets: object[], rollbackOrder: string[], dryRun?: boolean, confirm?: () => Promise<boolean> }} opts
 * @returns {Promise<{ exitCode: number, text: string }>}
 */
export async function rollbackReport(opts) {
  const { root, targets, rollbackOrder, dryRun = false } = opts;
  if (!targets.length) {
    return { exitCode: EXIT.TARGET_FAILURE, text: "No deploy targets discovered or configured." };
  }

  const plans = [];
  const errors = [];
  for (const target of targets) {
    const adapter = adapters[target.kind];
    try {
      adapter.auth(target, { root });
      const releases = adapter.releases(target, { root });
      if (releases.length < 2) {
        throw new Error("fewer than two production releases available");
      }
      plans.push({ target, current: releases[0], previous: releases[1] });
    } catch (err) {
      errors.push(`${targetLabel(target)}: ${err.message}`);
    }
  }

  const rows = plans.map((plan) => [
    targetLabel(plan.target),
    shortSha(plan.current.sha),
    shortSha(plan.previous.sha),
    formatAge(plan.current.deployedAt),
    formatAge(plan.previous.deployedAt),
  ]);
  let output = formatTable(
    ["Target", "Current SHA", "Rollback SHA", "Current Age", "Rollback Age"],
    rows,
  );
  if (errors.length) {
    output += `\n\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}`;
    output += "\n\nNo rollback actions were run.";
    return { exitCode: EXIT.TARGET_FAILURE, text: output };
  }
  if (dryRun) {
    output += "\n\nDry run: no rollback actions were run.";
    return { exitCode: EXIT.OK, text: output };
  }

  const confirmed = await (opts.confirm ?? confirmRollback)();
  if (!confirmed) {
    output += "\n\nConfirmation declined. No rollback actions were run.";
    return { exitCode: EXIT.DRIFT, text: output };
  }

  const groups = buildRollbackGroups(
    plans.map((plan) => plan.target),
    rollbackOrder,
  );
  const byKey = new Map(plans.map((plan) => [targetKey(plan.target), plan]));
  const results = [];
  for (const group of groups) {
    const groupResults = await Promise.all(
      group.map(async (target) => {
        const plan = byKey.get(targetKey(target));
        const adapter = adapters[target.kind];
        try {
          await adapter.rollback(target, plan.previous, { root });
          return { target, ok: true };
        } catch (err) {
          return { target, ok: false, error: err.message };
        }
      }),
    );
    results.push(...groupResults);
  }

  output += "\n\nRollback results:\n";
  output += results
    .map((result) =>
      result.ok
        ? `- ${targetLabel(result.target)}: rolled back`
        : `- ${targetLabel(result.target)}: failed - ${result.error}`,
    )
    .join("\n");
  const status = statusReport({ root, targets, noFetch: true });
  output += `\n\nPost-rollback deploy status:\n${status.text}`;

  const failed = results.some((result) => !result.ok);
  return {
    exitCode: failed ? EXIT.TARGET_FAILURE : status.exitCode,
    text: output,
  };
}

/**
 * @returns {Promise<boolean>}
 */
function confirmRollback() {
  return new Promise((resolve) => {
    process.stdout.write("\nType ROLLBACK PROD to continue: ");
    process.stdin.setEncoding("utf8");
    let input = "";
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolve(value);
    }
    function onData(chunk) {
      input += chunk;
      if (input.includes("\n")) done(input.trim() === "ROLLBACK PROD");
    }
    function onEnd() {
      done(input.trim() === "ROLLBACK PROD");
    }
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
// ---------------------------------------------------------------- smoke ----
//
// Smoke checks run against PRODUCTION right after a deploy, and an http check
// may carry a real credential. That makes this the one place in this helper
// where a mistake leaks a secret rather than merely reporting a wrong number,
// so the guards below are behavior, not advice (SEC-8).
//
// Everything here is self-contained on purpose (KD-13): scaffolded copies of
// this file sit in consumer repositories with no dotbabel package source to
// import, so a shared helper would simply be missing there.

/** Total wall-clock bound for one smoke run, in ms (PERF-6). */
const SMOKE_TOTAL_BUDGET_MS = 300_000;

/** Per-request bound for one http check, in ms (PERF-6). */
const SMOKE_REQUEST_TIMEOUT_MS = 10_000;

/** Retries for an http GET. A command check never retries (REL-8). */
const SMOKE_HTTP_RETRIES = 3;

/** At most 3 redirects, and only to the same https origin (SEC-8). */
const SMOKE_MAX_REDIRECTS = 3;

/**
 * The wait before each retry: 2s, 4s, 8s (PERF-6).
 *
 * Exported so the schedule can be swept across retry counts rather than
 * checked at the three values the default happens to use.
 *
 * @param {number} retries
 * @returns {number[]}
 */
export function smokeBackoffSchedule(retries) {
  const count = Number.isInteger(retries) && retries > 0 ? retries : 0;
  return Array.from({ length: count }, (_, index) => 2000 * 2 ** index);
}

/**
 * Validate a smoke URL before any request is made (SEC-8).
 *
 * @param {string} raw
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function validateSmokeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  // Credentials in a URL end up in logs, in shell history, and in any error
  // this helper prints. Refuse rather than redact: a config carrying one is a
  // committed secret, which redaction cannot undo.
  if (url.username || url.password) return { ok: false, reason: "URL must not embed credentials" };
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return { ok: true, url };
  // http is allowed only on loopback, which has no network to be intercepted
  // on and no certificate to offer.
  if (url.protocol === "http:" && loopback) return { ok: true, url };
  return { ok: false, reason: `URL must use https (got ${url.protocol.replace(":", "")})` };
}

/**
 * Resolve configured headers to values, reading each ONLY from the named
 * environment variable (SEC-8).
 *
 * A literal string is refused: this config is committed, so a literal is a
 * secret in the repository. A missing variable fails the check rather than
 * silently sending no header, which would otherwise pass against an endpoint
 * that happens to allow anonymous access.
 *
 * @param {object|undefined} headers
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, values: Record<string,string>, names: string[], secrets: string[] } | { ok: false, reason: string }}
 */
export function resolveSmokeHeaders(headers, env) {
  const values = {};
  const names = [];
  const secrets = [];
  for (const [name, spec] of Object.entries(headers ?? {})) {
    names.push(name);
    if (typeof spec === "string") {
      return { ok: false, reason: `header ${name} must read from { "env": "VAR" }, not a literal value` };
    }
    const variable = spec?.env;
    if (typeof variable !== "string" || !variable) {
      return { ok: false, reason: `header ${name} must name an environment variable` };
    }
    const value = env?.[variable];
    if (typeof value !== "string" || value === "") {
      return { ok: false, reason: `header ${name} reads ${variable}, which is not set` };
    }
    values[name] = value;
    secrets.push(value);
  }
  return { ok: true, values, names, secrets };
}

/**
 * Replace every known secret with a placeholder.
 *
 * Applied to anything that reaches stdout or the JSON payload, including a
 * RESPONSE BODY: a failing endpoint that echoes the Authorization header back
 * would otherwise leak it through the very message written to report the
 * failure.
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function redactSmokeSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Whether an http attempt satisfies the check's expectations.
 *
 * Shared by the retry loop (deciding whether to stop early) and the final
 * verdict below it — both need the identical status/body comparison, and a
 * second, drifted copy is exactly how a check that "passes" during a retry
 * could later report as failed, or vice versa.
 *
 * Returns the two halves alongside the combined verdict, not a bare boolean:
 * the failure message has to name WHICH expectation failed, and collapsing
 * them produced the self-contradicting "expected status 200, got 200".
 *
 * @param {{ expect_status?: number, expect_text?: string }} check
 * @param {{ ok: boolean, status: number|null, body: string }} attempt
 * @returns {{ ok: boolean, statusOk: boolean, textOk: boolean }}
 */
function smokeCheckPasses(check, attempt) {
  // `attempt.ok` means "a response arrived", NOT "the response was good". With
  // no expectation declared, treating that as a pass made a check report green
  // against a hard 500 — a release gate turning an outage into a green deploy,
  // through the simplest config anyone would write first. So the default
  // expectation is 2xx rather than "anything that answers".
  const statusOk = attempt.ok && (check.expect_status === undefined
    ? Number(attempt.status) >= 200 && Number(attempt.status) < 300
    : attempt.status === check.expect_status);
  const textOk = check.expect_text === undefined || String(attempt.body ?? "").includes(String(check.expect_text));
  return { ok: Boolean(statusOk && textOk), statusOk, textOk };
}

/**
 * Perform one http attempt, following redirects manually.
 *
 * `redirect: "manual"` is load-bearing. Handing `follow` to fetch would let
 * the response decide where the secret header goes; the check below refuses
 * any hop that changes origin or drops to http (SEC-8).
 */
async function smokeHttpAttempt(check, headerValues, deps) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.requestTimeoutMs ?? SMOKE_REQUEST_TIMEOUT_MS;
  let current = check.url;
  for (let hop = 0; hop <= SMOKE_MAX_REDIRECTS; hop += 1) {
    const validated = validateSmokeUrl(current);
    // `fatal`: a refusal that a retry can never turn into a pass. Retrying it
    // would burn the budget, and — worse — a later attempt returning a
    // different response would MASK the refusal and report the check as
    // passing. Only transient failures get the backoff.
    if (!validated.ok) return { ok: false, fatal: true, status: null, body: "", reason: validated.reason };
    // A real abort signal, not a `timeoutMs` init key: `RequestInit` has no
    // such member and unknown keys are silently ignored, so the declared
    // PERF-6 bound did not exist at all. Verified against a server that
    // accepts the connection and never answers — the request simply hung, and
    // the 300s total budget could not save it because that is only read
    // BETWEEN checks, never mid-request.
    const response = await fetchFn(validated.url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { ...headerValues },
      signal: deps.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) return { ok: false, fatal: true, status, body: "", reason: "redirect without a location header" };
      const next = new URL(location, validated.url);
      if (next.origin !== validated.url.origin || next.protocol !== "https:") {
        return { ok: false, fatal: true, status, body: "", reason: `refused redirect to ${next.origin}` };
      }
      current = next.toString();
      continue;
    }
    const body = typeof response.text === "function" ? await response.text() : "";
    return { ok: true, status, body, reason: "" };
  }
  return { ok: false, fatal: true, status: null, body: "", reason: `more than ${SMOKE_MAX_REDIRECTS} redirects` };
}

/**
 * Run every target's smoke checks.
 *
 * @param {{ root: string, targets: object[], dryRun?: boolean, deps?: object }} options
 * @returns {Promise<{ exitCode: number, text: string, json: object, results: object[] }>}
 */
export async function smokeReport({ root, targets = [], dryRun = false, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const runCommand = deps.runCommand ?? ((argv) => runSync(argv[0], argv.slice(1), { cwd: root, timeoutMs: SMOKE_REQUEST_TIMEOUT_MS }));
  const started = now();
  const results = [];
  const lines = [];
  let budgetExceeded = false;

  const planned = targets.filter((target) => Array.isArray(target?.smoke) && target.smoke.length > 0);
  if (planned.length === 0) {
    // Nothing declared is not a failure: exiting non-zero here would block
    // every release in a repository that has not adopted smoke checks.
    const json = { schema_version: 1, command: "smoke", verdict: "not_configured", dry_run: Boolean(dryRun), results: [], elapsed_ms: 0, budget_exceeded: false };
    return { exitCode: EXIT.OK, text: "smoke: no smoke checks declared in .claude/deploy-targets.json", json, results: [] };
  }

  outer: for (const target of planned) {
    const label = targetLabel(target);
    for (const check of target.smoke) {
      if (now() - started >= SMOKE_TOTAL_BUDGET_MS) {
        budgetExceeded = true;
        lines.push(`  ! stopped: exceeded the ${SMOKE_TOTAL_BUDGET_MS / 1000}s smoke budget`);
        break outer;
      }
      if (dryRun) {
        // `ok: null`, never `true`. A dry run that reported every check as
        // passing produced a payload a machine consumer could not tell from a
        // real pass, so a stray --dry-run in a pipeline would green-light a
        // production gate over zero executed checks.
        lines.push(`  - ${label} ${check.type} (dry run, not executed)`);
        results.push({ target: label, type: check.type === "command" ? "command" : "http", ok: null, attempts: 0 });
        continue;
      }

      if (check.type === "command") {
        // REL-8: exactly one attempt. A command may not be idempotent, and
        // retrying could repeat a side effect nobody agreed to.
        const argv = Array.isArray(check.argv) ? check.argv.map(String) : [];
        if (argv.length === 0) {
          results.push({ target: label, type: "command", ok: false, attempts: 1, argv, message: "command check requires argv" });
          lines.push(`  x ${label} command: requires argv`);
          continue;
        }
        const outcome = runCommand(argv);
        const ok = Boolean(outcome?.ok) && (outcome?.status ?? 0) === 0;
        results.push({ target: label, type: "command", ok, attempts: 1, argv, status: outcome?.status ?? null, message: ok ? "" : String(outcome?.stderr || outcome?.stdout || "command failed").trim().slice(0, 500) });
        lines.push(`  ${ok ? "+" : "x"} ${label} command ${argv.join(" ")}`);
        continue;
      }

      // URL FIRST, then headers. The reverse order meant a header failure —
      // an unset environment variable is the likeliest first-run mistake —
      // echoed the raw, unvalidated URL into both stdout and the payload,
      // credentials included. The no-echo rule held on one branch and broke on
      // its sibling four lines below. Validating first means every later echo
      // uses `validated.url`, which by construction carries no userinfo.
      const validated = validateSmokeUrl(check.url);
      if (!validated.ok) {
        // The URL is NOT echoed here: a rejected URL may be rejected precisely
        // because it embedded credentials.
        results.push({ target: label, type: "http", ok: false, attempts: 1, header_names: Object.keys(check.headers ?? {}), message: validated.reason });
        lines.push(`  x ${label} http: ${validated.reason}`);
        continue;
      }
      const headers = resolveSmokeHeaders(check.headers, env);
      if (!headers.ok) {
        results.push({ target: label, type: "http", ok: false, attempts: 1, url: validated.url.toString(), header_names: Object.keys(check.headers ?? {}), message: headers.reason });
        lines.push(`  x ${label} http ${validated.url} ${headers.reason}`);
        continue;
      }

      const schedule = smokeBackoffSchedule(SMOKE_HTTP_RETRIES);
      let attempts = 0;
      let last = { ok: false, status: null, body: "", reason: "not attempted" };
      for (let attempt = 0; attempt <= schedule.length; attempt += 1) {
        attempts += 1;
        try {
          last = await smokeHttpAttempt({ ...check, url: validated.url.toString() }, headers.values, deps);
        } catch (err) {
          last = { ok: false, status: null, body: "", reason: `request failed: ${err?.message ?? err}` };
        }
        if (smokeCheckPasses(check, last).ok) break;
        if (last.fatal) break;
        if (attempt < schedule.length) {
          await sleep(schedule[attempt]);
          if (now() - started >= SMOKE_TOTAL_BUDGET_MS) { budgetExceeded = true; break; }
        }
      }
      const { ok, statusOk } = smokeCheckPasses(check, last);
      // A snippet of the failing body is the most useful thing an operator can
      // see at 3am, and it is also exactly where a secret can come back out: an
      // endpoint that echoes the Authorization header back would otherwise leak
      // it through the very message written to report the failure. So the body
      // is included, truncated, and redacted — redaction is load-bearing here,
      // not decorative.
      const because = last.reason || (!statusOk ? `expected status ${check.expect_status}, got ${last.status}` : `body did not contain ${check.expect_text}`);
      const snippet = !ok && last.body ? ` — body: ${String(last.body).trim().slice(0, 200)}` : "";
      const detail = ok ? "" : redactSmokeSecrets(`${because}${snippet}`, headers.secrets);
      results.push({ target: label, type: "http", ok, attempts, url: validated.url.toString(), header_names: headers.names, status: last.status ?? null, message: detail });
      const sent = headers.names.length > 0 ? ` [headers: ${headers.names.join(", ")}]` : "";
      lines.push(redactSmokeSecrets(`  ${ok ? "+" : "x"} ${label} http ${validated.url}${sent} ${ok ? "ok" : detail}`, headers.secrets));
      if (budgetExceeded) {
        lines.push(`  ! stopped: exceeded the ${SMOKE_TOTAL_BUDGET_MS / 1000}s smoke budget`);
        break outer;
      }
    }
  }

  const failed = results.filter((item) => item.ok === false);
  const verdict = dryRun ? "not_run" : failed.length > 0 || budgetExceeded ? "fail" : "pass";
  const json = {
    schema_version: 1,
    command: "smoke",
    verdict,
    dry_run: Boolean(dryRun),
    budget_exceeded: budgetExceeded,
    elapsed_ms: Math.max(0, now() - started),
    results,
  };
  const header = dryRun
    ? `smoke: ${results.length} check(s) planned, none executed (dry run)`
    : verdict === "pass" ? `smoke: ${results.length} check(s) passed` : `smoke: ${failed.length} of ${results.length} check(s) failed`;
  return {
    // A dry run exits 0: it asserts nothing and must not block a pipeline. The
    // verdict and dry_run flag are what a consumer reads to know why.
    exitCode: verdict === "pass" || verdict === "not_run" ? EXIT.OK : EXIT.DRIFT,
    text: [header, ...lines].join("\n"),
    json,
    results,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const root = resolveProjectRoot(cwd);
  let resolved;
  try {
    resolved = resolveTargets(root);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.TARGET_FAILURE;
  }

  if (command === "status" || command === "deploy-status") {
    const report = statusReport({
      root,
      targets: resolved.targets,
      noFetch: Boolean(flags["no-fetch"]),
      dryRun: Boolean(flags["dry-run"]),
    });
    process.stdout.write(`${report.text}\n`);
    return report.exitCode;
  }

  if (command === "rollback" || command === "rollback-prod") {
    const report = await rollbackReport({
      root,
      targets: resolved.targets,
      rollbackOrder: resolved.rollbackOrder,
      dryRun: Boolean(flags["dry-run"]),
    });
    process.stdout.write(`${report.text}\n`);
    return report.exitCode;
  }

  if (command === "smoke") {
    const report = await smokeReport({
      root,
      targets: resolved.targets,
      dryRun: Boolean(flags["dry-run"]),
    });
    process.stdout.write(`${flags.json ? JSON.stringify(report.json, null, 2) : report.text}\n`);
    return report.exitCode;
  }

  process.stderr.write(
    "Usage: deploy-ops.mjs <status|rollback|smoke> [--dry-run] [--json] [--cwd <dir>] [--no-fetch]\n",
  );
  return EXIT.USAGE;
}

// Run-direct guard, symlink-safe. bootstrap.sh symlinks this skill into
// ~/.claude/skills/, and SKILL.md prefers that path — Node realpath-resolves
// the entry module while argv[1] keeps the symlink, so a verbatim comparison
// concludes the script was imported and exits 0 without running, which
// callers read as "every target in sync". Compare realpaths on both sides.
// (Inlined rather than shared: scaffolded copies of this file have no
// plugins/dotbabel/src to import a helper from.)
let runDirect = false;
if (process.argv[1]) {
  const self = fileURLToPath(import.meta.url);
  runDirect = self === process.argv[1];
  if (!runDirect) {
    try {
      runDirect = realpathSync(self) === realpathSync(process.argv[1]);
    } catch {
      runDirect = false;
    }
  }
}
if (runDirect) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export const __filename = fileURLToPath(import.meta.url);
