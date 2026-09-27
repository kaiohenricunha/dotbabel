// Additive boundary tests for `quality/adapters/node-tools.mjs`, closing the
// gap between its indirect coverage (via javascript.mjs/typescript.mjs, and
// through quality-adapters.test.mjs/quality-discovery.test.mjs) and the
// TEST-1 mutation-score floor (baseline 80.63%, 160 mutants).
//
// Four mutants are documented as genuinely equivalent rather than chased:
//   - 24:76-82 (`readFileSync(..., "utf8")` -> `""` in `readPackage`): same
//     Buffer-vs-string coercion equivalence already established repeatedly
//     this session (spec-file.mjs, confirm.mjs, spec-harness-lib.mjs) —
//     `JSON.parse` accepts a Buffer via its default (utf8) `.toString()`.
//   - 129:104-106 (`CONVENTIONAL[capability] ?? []` -> `?? ["Stryker was
//     here"]`): this fallback only fires for a capability with no
//     CONVENTIONAL entry (regression, complexity, mutation, dead-code,
//     dependencies, duplication, security). Either way the array is then
//     `.filter((name) => scripts[name] !== undefined)`, and no real
//     package.json script is ever named the literal sentinel text, so the
//     filtered result is `[]` regardless of which fallback fired.
//   - 93:32-42 (`capabilityRules("coverage")` -> `capabilityRules("")`):
//     `shared.mjs`'s `capabilityRules` maps `coverage` to `[]` explicitly
//     and falls back to `[]` (`?? []`) for any key it doesn't recognize,
//     including `""` — the two calls return the identical empty array.
//   - 81:98-103 (`includeTests = false` -> `= true`, on
//     `nodeBuiltinCoveragePlans`): `capabilityInProfile`'s `includeTests`
//     flag only ever escalates the `"test"` capability
//     (`includeTests && capability === "test"`), and this function only
//     ever checks `"coverage"` — so the parameter has no observable effect
//     on this function's behavior for any profile, by construction.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeBuiltinCoveragePlans, nodeRepositoryPlans } from "../src/quality/adapters/node-tools.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tmpRoot(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-tools-behavior-"));
  dirs.push(dir);
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

function byCapability(plans, capability) {
  return plans.find((p) => p.capability === capability);
}

describe("nodeBuiltinCoveragePlans", () => {
  it("does not plan coverage when the capability is already claimed", () => {
    const root = tmpRoot({ dependencies: { "@vitest/coverage-v8": "1.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr", new Set(["coverage"]), false);
    expect(plans).toEqual([]);
  });

  it("plans nothing when neither vitest's provider nor jest is declared", () => {
    const root = tmpRoot({ dependencies: { lodash: "1.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans).toEqual([]);
  });

  it("finds the istanbul vitest provider too, not only the v8 one", () => {
    const root = tmpRoot({ devDependencies: { "@vitest/coverage-istanbul": "1.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans).toHaveLength(1);
    expect(plans[0].argv).toContain("vitest");
  });

  it("finds a vitest coverage provider declared under dependencies, not only devDependencies", () => {
    // `{ ...(pkg.dependencies ?? {}) }` merged with `&&` instead of `??`
    // would spread an empty object whenever `dependencies` is a real,
    // truthy object — silently dropping every dependency it declares.
    const root = tmpRoot({ dependencies: { "@vitest/coverage-v8": "1.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans).toHaveLength(1);
    expect(plans[0].capability).toBe("coverage");
  });

  it("plans vitest coverage with the exact expected id, argv, and metadata", () => {
    const root = tmpRoot({ devDependencies: { "@vitest/coverage-v8": "1.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans).toEqual([
      {
        id: ".:javascript:coverage:vitest",
        componentId: ".:javascript",
        capability: "coverage",
        ruleIds: [],
        executable: "npx",
        argv: ["--no-install", "vitest", "run", "--coverage", "--coverage.reporter=json", "--coverage.reportsDirectory=.dotbabel/quality"],
        cwd: root,
        report: { format: "istanbul-json", path: ".dotbabel/quality/coverage-final.json" },
        availability: "candidate",
        source: "built-in",
        requiresTrust: true,
      },
    ]);
  });

  it("plans jest coverage with the exact expected argv when jest is declared, not vitest", () => {
    const root = tmpRoot({ devDependencies: { jest: "29.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans).toEqual([
      {
        id: ".:javascript:coverage:jest",
        componentId: ".:javascript",
        capability: "coverage",
        ruleIds: [],
        executable: "npx",
        argv: ["--no-install", "jest", "--coverage", "--coverageReporters=json", "--coverageDirectory=.dotbabel/quality"],
        cwd: root,
        report: { format: "istanbul-json", path: ".dotbabel/quality/coverage-final.json" },
        availability: "candidate",
        source: "built-in",
        requiresTrust: true,
      },
    ]);
  });

  it("uses --no-install, not a bare npx invocation, so a missing binary fails cleanly instead of installing one", () => {
    const root = tmpRoot({ devDependencies: { jest: "29.0.0" } });
    const plans = nodeBuiltinCoveragePlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(plans[0].argv[0]).toBe("--no-install");
  });

});

describe("nodeRepositoryPlans", () => {
  const ALL_CAPABILITIES = ["format", "typecheck", "lint", "test", "regression", "coverage", "complexity", "mutation", "dead-code", "dependencies", "duplication", "security"];

  it("checks every capability in its iteration list, not a subset of it", () => {
    const scripts = Object.fromEntries(ALL_CAPABILITIES.map((c) => [`quality:${c}`, "echo x"]));
    const root = tmpRoot({ scripts });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "deep", new Set(), true);
    const found = new Set(plans.map((p) => p.capability));
    for (const capability of ALL_CAPABILITIES) {
      expect(found.has(capability)).toBe(true);
    }
  });

  it("prefers a quality: namespaced script over the conventional one", () => {
    const root = tmpRoot({ scripts: { "quality:lint": "eslint --strict .", lint: "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "lint").argv).toEqual(["run", "quality:lint"]);
  });

  it("falls back to the conventional script name when no quality: script exists", () => {
    const root = tmpRoot({ scripts: { lint: "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "lint")).toMatchObject({
      id: ".:javascript:lint:lint",
      executable: "npm",
      argv: ["run", "lint"],
      source: "repository-script",
      requiresTrust: true,
    });
  });

  it("recognizes format:check as the conventional format script", () => {
    const root = tmpRoot({ scripts: { "format:check": "prettier --check ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "format").argv).toEqual(["run", "format:check"]);
  });

  it("recognizes either typecheck or check:types as the conventional typecheck script", () => {
    const withTypecheck = tmpRoot({ scripts: { typecheck: "tsc --noEmit" } });
    expect(byCapability(nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: withTypecheck }, "pr"), "typecheck").argv).toEqual(["run", "typecheck"]);

    const withCheckTypes = tmpRoot({ scripts: { "check:types": "tsc --noEmit" } });
    expect(byCapability(nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: withCheckTypes }, "pr"), "typecheck").argv).toEqual(["run", "check:types"]);
  });

  it("does not plan a capability with no matching script at all", () => {
    const root = tmpRoot({ scripts: { lint: "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "format")).toBeUndefined();
  });

  it("skips a capability that is already claimed", () => {
    const root = tmpRoot({ scripts: { lint: "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr", new Set(["lint"]));
    expect(byCapability(plans, "lint")).toBeUndefined();
  });

  it("reports two equal-authority scripts as ambiguous, with the exact expected id and evidence", () => {
    const root = tmpRoot({ scripts: { "quality:lint": "eslint --strict .", "quality-lint": "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "lint")).toEqual({
      id: ".:javascript:lint:ambiguous",
      componentId: ".:javascript",
      capability: "lint",
      ruleIds: ["correctness.lint"],
      availability: "not_configured",
      candidates: ["quality:lint", "quality-lint"],
      evidence: "equal-authority package scripts require a project tool override",
    });
  });

  it("marks a single repository-script plan as requiring trust", () => {
    const root = tmpRoot({ scripts: { lint: "eslint ." } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "lint").requiresTrust).toBe(true);
  });

  it("defaults includeTests to false when the caller omits it entirely", () => {
    const root = tmpRoot({ scripts: { test: "vitest run" } });
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "fast", new Set());
    expect(byCapability(plans, "test")).toBeUndefined();
  });

  it("uses the package manager implied by a lockfile for the executable, not always npm", () => {
    const root = tmpRoot({ scripts: { lint: "eslint ." } });
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const plans = nodeRepositoryPlans({ id: ".:javascript", absoluteRoot: root }, "pr");
    expect(byCapability(plans, "lint").executable).toBe("pnpm");
  });
});
