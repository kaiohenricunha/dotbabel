import fs from "node:fs";
import path from "node:path";

import { capabilityInProfile, capabilityRules } from "./shared.mjs";

const CONVENTIONAL = Object.freeze({
  format: ["format:check"],
  typecheck: ["typecheck", "check:types"],
  lint: ["lint"],
  test: ["test"],
  // A `coverage` script is how most repositories already spell this, and it
  // must outrank the built-in plan below: the script encodes reporter and
  // threshold choices that inspecting package.json cannot see.
  coverage: ["coverage"],
});

function manager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function readPackage(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch { return {}; }
}

function readScripts(root) {
  return readPackage(root).scripts ?? {};
}

/** Where a built-in coverage plan writes its Istanbul report. */
const COVERAGE_REPORT_PATH = ".dotbabel/quality/coverage-final.json";

/**
 * Vitest cannot produce a coverage report without a provider package, so the
 * provider — not `vitest` itself — is what makes coverage plannable.
 */
const VITEST_PROVIDERS = ["@vitest/coverage-v8", "@vitest/coverage-istanbul"];

/**
 * Run a locally installed binary the way the repository's package manager does.
 *
 * `npx` resolves `node_modules/.bin` before PATH, so this never reaches for a
 * global install, and it never installs anything: the caller has already
 * confirmed the package is a declared dependency.
 */
function exec(root, binary, args) {
  const pm = manager(root);
  if (pm === "pnpm") return { executable: "pnpm", argv: ["exec", binary, ...args] };
  // `yarn exec`, never `yarn <binary>`: on Yarn 1 the bare form is shorthand
  // for `yarn run <binary>`, which resolves package.json `scripts` BEFORE
  // node_modules/.bin. A repository with a script named `vitest` would have it
  // run instead of the binary, silently, and no report would appear at the
  // path this plan declares.
  if (pm === "yarn") return { executable: "yarn", argv: ["exec", binary, ...args] };
  return { executable: "npx", argv: ["--no-install", binary, ...args] };
}

/**
 * Built-in Node coverage for a declared runner, when the repository owns no
 * coverage script (KD-8).
 *
 * Declaration is the whole gate. `dotbabel quality` never installs a checker,
 * so planning coverage for a repository that does not declare a runner yields
 * a plan that can only resolve through `on_unavailable` — which reads as a
 * finding rather than as "nothing to measure here". A repository script keeps
 * priority, because it encodes choices this cannot see.
 *
 * Note that a Make target does NOT take priority here, unlike in the Python
 * and Go adapters: `makeRepositoryPlans` is wired into those two only, so a
 * Node component with a `coverage` Make target and no script still gets this
 * built-in plan.
 *
 * @param {object} component
 * @param {string} profile
 * @param {Set<string>} claimed Capabilities an earlier, higher-priority source already planned.
 * @param {boolean} includeTests
 * @returns {object[]}
 */
export function nodeBuiltinCoveragePlans(component, profile, claimed = new Set(), includeTests = false) {
  if (claimed.has("coverage") || !capabilityInProfile("coverage", profile, includeTests)) return [];
  const root = component.absoluteRoot;
  const pkg = readPackage(root);
  const declared = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };

  const plan = (binary, args) => {
    const command = exec(root, binary, args);
    return [{
      id: `${component.id}:coverage:${binary}`,
      componentId: component.id,
      capability: "coverage",
      ruleIds: capabilityRules("coverage"),
      ...command,
      cwd: root,
      report: { format: "istanbul-json", path: COVERAGE_REPORT_PATH },
      // `candidate`, not `available`: a manifest entry proves the package is
      // DECLARED, not installed. `node_modules` may be absent entirely.
      availability: "candidate",
      source: "built-in",
      requiresTrust: true,
    }];
  };

  if (VITEST_PROVIDERS.some((name) => declared[name] !== undefined)) {
    return plan("vitest", ["run", "--coverage", "--coverage.reporter=json", `--coverage.reportsDirectory=${path.posix.dirname(COVERAGE_REPORT_PATH)}`]);
  }
  if (declared.jest !== undefined) {
    return plan("jest", ["--coverage", "--coverageReporters=json", `--coverageDirectory=${path.posix.dirname(COVERAGE_REPORT_PATH)}`]);
  }
  return [];
}

/**
 * Select repository-owned Node scripts without executing package metadata.
 *
 * Needs no unowned-component guard, unlike its Make sibling: the file it reads
 * for candidates (package.json) is the same file that proves the component
 * exists, so a component with no marker yields no scripts.
 */
export function nodeRepositoryPlans(component, profile, claimed = new Set(), includeTests = false) {
  const root = component.absoluteRoot;
  const scripts = readScripts(root);
  const executable = manager(root);
  const plans = [];
  for (const capability of ["format", "typecheck", "lint", "test", "regression", "coverage", "complexity", "mutation", "dead-code", "dependencies", "duplication", "security"]) {
    if (claimed.has(capability) || !capabilityInProfile(capability, profile, includeTests)) continue;
    const qualityCandidates = [`quality:${capability}`, `quality-${capability}`].filter((name) => scripts[name] !== undefined);
    const candidates = qualityCandidates.length > 0 ? qualityCandidates : (CONVENTIONAL[capability] ?? []).filter((name) => scripts[name] !== undefined);
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      plans.push({ id: `${component.id}:${capability}:ambiguous`, componentId: component.id, capability, ruleIds: capabilityRules(capability), availability: "not_configured", candidates, evidence: "equal-authority package scripts require a project tool override" });
      continue;
    }
    plans.push({ id: `${component.id}:${capability}:${candidates[0]}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable, argv: ["run", candidates[0]], cwd: root, availability: "available", source: "repository-script", requiresTrust: true });
  }
  return plans;
}
