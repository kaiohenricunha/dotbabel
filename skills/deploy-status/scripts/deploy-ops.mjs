#!/usr/bin/env node
/**
 * deploy-ops.mjs
 *
 * Shared implementation for the deploy-status and rollback-prod skills.
 * The public contract is the skill workflow; this file keeps platform
 * discovery and provider adapters testable.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    if (result.ok || result.status === 0) return candidate;
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

  for (const target of targets) {
    const adapter = adapters[target.kind];
    try {
      adapter.auth(target, { root });
      const [current] = adapter.releases(target, { root });
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
  const status = statusReport({ root, targets });
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
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) {
        resolve(input.trim() === "ROLLBACK PROD");
      }
    });
    process.stdin.on("end", () => {
      resolve(input.trim() === "ROLLBACK PROD");
    });
  });
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
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

  process.stderr.write(
    "Usage: deploy-ops.mjs <status|rollback> [--dry-run] [--cwd <dir>] [--no-fetch]\n",
  );
  return EXIT.USAGE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export const __filename = fileURLToPath(import.meta.url);
