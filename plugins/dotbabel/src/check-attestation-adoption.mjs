/**
 * check-attestation-adoption — read-only report on whether a repository's
 * `attestation` policy can actually work.
 *
 * `attestation.enforce: true` in `.dotbabel.json` makes the merge gate refuse
 * any pull request without trusted, current attestation evidence. That is only
 * as good as the configuration behind it, and the failures are all silent until
 * a real pull request is blocked or, worse, waved through: enforcement with no
 * local-attest config blocks every merge; a config file outside
 * `governance_files` lets a pull request rewrite its own legs; a required leg
 * the matrix never runs blocks every merge with ATTESTATION_INCOMPLETE.
 *
 * Nothing here mutates the filesystem, and the only code it can execute is the
 * repository's own `.local-attest.config.mjs`. The caller passes
 * `canExecuteConfig` to say whether that is permitted; without it an
 * executable config is reported as uninspected rather than loaded.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_GOVERNANCE_FILES, isGovernablePath } from "./attestation.mjs";
import { loadConfig } from "./local-attest-config.mjs";

/** Same discovery order as `loadConfig`, minus the `--config` override. */
const CONFIG_FILES = [
  { path: ".local-attest.config.mjs", executable: true },
  { path: ".local-attest.config.json", executable: false },
];

/** A leg command that runs a package script, which lives in ungoverned package.json by default. */
const PACKAGE_RUNNER_RE = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s|$)/;

/**
 * True when a leg command runs a package script (`npm test`, `pnpm run lint`, ...).
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function usesPackageRunner(command) {
  return typeof command === "string" && PACKAGE_RUNNER_RE.test(command);
}

/**
 * @typedef {{ level: "pass"|"info"|"warn"|"fail", code: string, message: string }} Finding
 * @typedef {{ state: "off"|"enforcing", ok: boolean, findings: Finding[] }} AdoptionReport
 */

/**
 * @param {string} repoRoot
 * @returns {{ path: string, executable: boolean } | null}
 */
function findConfigSource(repoRoot) {
  for (const c of CONFIG_FILES) {
    if (existsSync(join(repoRoot, c.path))) return c;
  }
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const hasConfig = JSON.parse(readFileSync(pkgPath, "utf8"))?.["local-attest"];
    return hasConfig ? { path: "package.json", executable: false } : null;
  } catch {
    // `loadConfig` throws on an unparseable package.json it reaches, so this is
    // a config source that cannot load: let the loader report it.
    return { path: "package.json", executable: false };
  }
}

/**
 * @param {string} repoRoot
 * @returns {{ policy: object|null, unreadable: string|null }}
 */
function readPolicy(repoRoot) {
  const file = join(repoRoot, ".dotbabel.json");
  if (!existsSync(file)) return { policy: null, unreadable: null };
  try {
    const attestation = JSON.parse(readFileSync(file, "utf8"))?.attestation;
    return { policy: attestation ?? null, unreadable: null };
  } catch (err) {
    return { policy: null, unreadable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {boolean} args.canExecuteConfig  true when loading `.local-attest.config.mjs` is permitted
 * @param {(args: { cwd: string }) => Promise<{ matrix: any[] }>} [args.loadConfigFn]
 * @returns {Promise<AdoptionReport>}
 */
export async function checkAttestationAdoption({
  repoRoot,
  canExecuteConfig,
  loadConfigFn = loadConfig,
}) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  const { policy, unreadable } = readPolicy(repoRoot);
  if (unreadable !== null) {
    add(
      "warn",
      "POLICY_UNREADABLE",
      `.dotbabel.json does not parse (${unreadable}); the merge gate reads that as no policy, so attestation is not enforced`,
    );
  }

  if (policy?.enforce !== true) {
    const hasConfig = findConfigSource(repoRoot) !== null;
    add(
      "info",
      "ATTESTATION_OFF",
      "attestation enforcement is off, so /merge-pr verifies explicitly instead of reusing local-attest evidence" +
        `${hasConfig ? " (a local-attest config exists, so this repository can adopt enforcement)" : ""}; ` +
        "see docs/attestation.md to adopt it",
    );
    return { state: "off", ok: true, findings };
  }

  const declared = Array.isArray(policy.governance_files) && policy.governance_files.length > 0;
  const governance = declared ? policy.governance_files.map(String) : [...DEFAULT_GOVERNANCE_FILES];

  const invalid = governance.filter((p) => !isGovernablePath(p));
  if (invalid.length > 0) {
    add(
      "fail",
      "GOVERNANCE_PATH_INVALID",
      `governance_files has ${invalid.length} entr${invalid.length === 1 ? "y" : "ies"} that must be plain relative paths: ` +
        `${invalid.map((p) => JSON.stringify(p)).join(", ")}. The gate drops them and local-attest still hashes them, ` +
        "so the hashes never match and every pull request is blocked with ATTESTATION_CONFIG_CHANGED",
    );
  }
  if (declared) {
    const missing = governance.filter((p) => isGovernablePath(p) && !existsSync(join(repoRoot, p)));
    if (missing.length > 0) {
      add(
        "warn",
        "GOVERNED_FILE_MISSING",
        `governance_files lists ${missing.join(", ")}, which ${missing.length === 1 ? "does" : "do"} not exist; ` +
          "a misspelled entry governs nothing",
      );
    }
  }

  const required = Array.isArray(policy.required_legs) ? policy.required_legs.map(String) : [];
  if (required.length === 0) {
    add(
      "warn",
      "NO_REQUIRED_LEGS",
      "attestation.required_legs is empty, so an attestation is accepted whichever legs its matrix contained; " +
        "name the legs merge-time verification no longer runs itself",
    );
  }

  const source = findConfigSource(repoRoot);
  if (!source) {
    add(
      "fail",
      "NO_CONFIG",
      "attestation.enforce is true but there is no local-attest config (.local-attest.config.mjs, " +
        ".local-attest.config.json, or package.json#local-attest), so nothing can produce evidence " +
        "and every pull request is blocked with ATTESTATION_MISSING",
    );
  } else {
    if (!governance.includes(source.path)) {
      add(
        "fail",
        "CONFIG_UNGOVERNED",
        `${source.path} defines the matrix but is not in governance_files, so a pull request can rewrite a leg ` +
          "to `true` and still attest itself; add it to attestation.governance_files",
      );
    }
    if (source.executable && !canExecuteConfig) {
      add(
        "warn",
        "LEGS_UNINSPECTED",
        `${source.path} is executable and this repository is not trusted, so its legs were not inspected; ` +
          "run `dotbabel project-init --trust` and re-run doctor",
      );
    } else {
      await inspectLegs({ repoRoot, source, governance, required, loadConfigFn, add });
    }
  }

  const clean = findings.every((f) => f.level !== "fail" && f.level !== "warn");
  if (clean)
    add(
      "pass",
      "ATTESTATION_ADOPTED",
      "attestation enforcement is on and its configuration is coherent",
    );
  return { state: "enforcing", ok: !findings.some((f) => f.level === "fail"), findings };
}

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {{ path: string }} args.source
 * @param {string[]} args.governance
 * @param {string[]} args.required
 * @param {(args: { cwd: string }) => Promise<{ matrix: any[] }>} args.loadConfigFn
 * @param {(level: Finding["level"], code: string, message: string) => void} args.add
 */
async function inspectLegs({ repoRoot, source, governance, required, loadConfigFn, add }) {
  let matrix;
  try {
    matrix = (await loadConfigFn({ cwd: repoRoot })).matrix;
  } catch (err) {
    add(
      "fail",
      "CONFIG_INVALID",
      `${source.path} does not load: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const byName = new Map(matrix.map((leg) => [leg.name, leg]));
  const unknown = required.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    add(
      "fail",
      "REQUIRED_LEG_UNKNOWN",
      `attestation.required_legs names ${unknown.map((n) => JSON.stringify(n)).join(", ")}, which the matrix does not ` +
        "contain, so every pull request is blocked with ATTESTATION_INCOMPLETE",
    );
  }

  const skippable = required.filter((name) => {
    const leg = byName.get(name);
    return leg && (leg.when || leg.skipWhenDiffOnly);
  });
  if (skippable.length > 0) {
    add(
      "warn",
      "REQUIRED_LEG_SKIPPABLE",
      `required leg ${skippable.map((n) => JSON.stringify(n)).join(", ")} can be skipped by a path filter, ` +
        "and a skipped leg is not a pass, so a pull request that skips it is blocked with ATTESTATION_INCOMPLETE",
    );
  }

  if (!governance.includes("package.json")) {
    const viaPackage = matrix.filter(
      (leg) => typeof leg.command === "string" && PACKAGE_RUNNER_RE.test(leg.command),
    );
    if (viaPackage.length > 0) {
      add(
        "warn",
        "LEG_COMMAND_UNGOVERNED",
        `${viaPackage.map((leg) => JSON.stringify(leg.name)).join(", ")} run${viaPackage.length === 1 ? "s" : ""} a ` +
          "package script, and package.json is not in governance_files, so a pull request can rewrite the script " +
          "and still attest itself",
      );
    }
  }
}
