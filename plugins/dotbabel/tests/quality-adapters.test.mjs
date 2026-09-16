import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getQualityAdapter } from "../src/quality/adapters/registry.mjs";

describe("quality adapters", () => {
  it.each(["go", "python", "typescript", "javascript"])("registers the %s adapter", (language) => {
    expect(getQualityAdapter(language)?.id).toBe(language);
  });

  it("uses built-ins without installing tools", () => {
    const adapter = getQualityAdapter("go");
    const plans = adapter.plan({ id: ".:go", root: ".", language: "go", files: ["main.go"], tools: {} }, { rules: {} }, { changedFiles: [{ path: "main.go" }] }, "fast");
    expect(plans.some((plan) => plan.argv?.includes("install"))).toBe(false);
    expect(plans.some((plan) => plan.capability === "format")).toBe(true);
  });

  it("keeps mutation out of fast and pr profiles", () => {
    const adapter = getQualityAdapter("python");
    for (const profile of ["fast", "pr"]) {
      expect(adapter.plan({ id: ".:python", root: ".", language: "python", files: ["a.py"], tools: {} }, { rules: {} }, { changedFiles: [] }, profile).some((plan) => plan.capability === "mutation")).toBe(false);
    }
  });

  it("keeps tests and coverage out of the fast profile", () => {
    const adapter = getQualityAdapter("javascript");
    const plans = adapter.plan({ id: ".:javascript", root: ".", absoluteRoot: process.cwd(), language: "javascript", files: [], tools: {
      test: { argv: ["npm", "test"] }, coverage: { argv: ["npm", "run", "coverage"] }, lint: { argv: ["npm", "run", "lint"] },
    } }, { rules: {} }, { changedFiles: [] }, "fast");
    expect(plans.map((plan) => plan.capability)).toEqual(["lint"]);
  });

  it("prefers a repository quality script over a conventional script", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-node-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint .", lint: "eslint src" } }));
      const plans = getQualityAdapter("javascript").plan({ id: ".:javascript", root: ".", absoluteRoot: root, language: "javascript", files: [], markers: ["package.json"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint").argv).toEqual(["run", "quality:lint"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("reports equal-authority quality scripts as ambiguous", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-node-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint .", "quality-lint": "eslint src" } }));
      const plans = getQualityAdapter("javascript").plan({ id: ".:javascript", root: ".", absoluteRoot: root, language: "javascript", files: [], markers: ["package.json"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ availability: "not_configured", candidates: ["quality:lint", "quality-lint"] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("prefers a Go quality Make target over the built-in", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-go-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "Makefile"), "quality-test:\n\tgo test ./...\n");
      const plans = getQualityAdapter("go").plan({ id: ".:go", root: ".", absoluteRoot: root, language: "go", files: ["main.go"], markers: ["go.mod"], tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans.find((plan) => plan.capability === "test")).toMatchObject({ executable: "make", argv: ["quality-test"], source: "repository-target" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not let a markerless component claim repository Make targets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-markerless-adapter-"));
    try {
      // #337: this `lint` target belongs to another language entirely.
      fs.writeFileSync(path.join(root, "Makefile"), "lint:\n\tgolangci-lint run ./...\n");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["tools/helper.py"], markers: [], tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("lets an unowned component claim the explicit quality- namespace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-unowned-quality-"));
    try {
      // `quality-lint` is dotbabel's own opt-in convention: it cannot be claimed
      // by accident the way a bare `lint` can, so #337 does not apply to it.
      fs.writeFileSync(path.join(root, "Makefile"), "quality-lint:\n\truff check .\nlint:\n\tgolangci-lint run ./...\n");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["tools/helper.py"], markers: [], tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "make", argv: ["quality-lint"], source: "repository-target" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("still claims repository Make targets for an operator-declared component", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-configured-adapter-"));
    try {
      // discovery.mjs seeds a policy.components entry with markers: [], so the
      // declaration -- a stronger claim than any marker -- must not read as unowned.
      fs.writeFileSync(path.join(root, "Makefile"), "lint:\n\truff check .\n");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["a.py"], markers: [], configured: true, tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "make", argv: ["lint"], source: "repository-target" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("still claims repository Make targets for a component with a manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-marked-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "Makefile"), "lint:\n\truff check .\n");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["a.py"], markers: ["pyproject.toml"], tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "make", argv: ["lint"], source: "repository-target" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the detected Python package manager for configured Ruff", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-python-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
      fs.writeFileSync(path.join(root, "uv.lock"), "");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["a.py"], markers: ["pyproject.toml"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "uv", argv: ["run", "ruff", "check", "."], requiresTrust: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a local TypeScript compiler and maps type checks to compile and type rules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-typescript-adapter-"));
    try {
      fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", ".bin", "tsc"), "");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint ." } }));
      const plans = getQualityAdapter("typescript").plan({
        id: ".:typescript", root: ".", absoluteRoot: root, language: "typescript", files: ["a.ts"], markers: ["tsconfig.json"], tools: {},
      }, { rules: {} }, { changedFiles: [{ path: "a.ts" }] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "npm", argv: ["run", "quality:lint"] });
      expect(plans.find((plan) => plan.capability === "typecheck")).toMatchObject({
        executable: "./node_modules/.bin/tsc",
        argv: ["--noEmit", "-p", "tsconfig.json"],
        ruleIds: ["correctness.compile", "correctness.types"],
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a PATH TypeScript compiler when no project binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-typescript-adapter-"));
    try {
      const plans = getQualityAdapter("typescript").plan({
        id: ".:typescript", root: ".", absoluteRoot: root, language: "typescript", files: ["a.ts"], markers: [], tools: {},
      }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "typecheck")).toMatchObject({ executable: "tsc", argv: ["--noEmit", "-p", "tsconfig.json"] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("terminates node --check flag parsing so a changed filename cannot inject a Node CLI flag", () => {
    const evil = "--require=payload.js";
    const plans = getQualityAdapter("javascript").plan({
      id: ".:javascript", root: ".", absoluteRoot: process.cwd(), language: "javascript", files: [evil], tools: {},
    }, { rules: {} }, { changedFiles: [{ path: evil }] }, "fast");
    const plan = plans.find((item) => item.capability === "compile" && item.source === "built-in");
    expect(plan.argv[0]).toBe("--check");
    expect(plan.argv[1]).toBe("--");
    expect(plan.argv[2]).toMatch(/^\.\//);
  });

  it("terminates gofmt flag parsing so a changed filename cannot inject a gofmt CLI flag", () => {
    const evil = "-cpuprofile=pwned.go";
    const plans = getQualityAdapter("go").plan({
      id: ".:go", root: ".", absoluteRoot: process.cwd(), language: "go", files: [evil], tools: {},
    }, { rules: {} }, { changedFiles: [{ path: evil }] }, "fast");
    const plan = plans.find((item) => item.capability === "format");
    expect(plan.argv[0]).toBe("-l");
    expect(plan.argv[1]).toBe("--");
    expect(plan.argv[2]).toMatch(/^\.\//);
  });
});

// --- P-C2 / P-C3: built-in test and coverage plans for DECLARED tools -------
//
// KD-8 draws one line through both units: a plan exists only when the
// repository already declares the tool. `dotbabel quality` never installs a
// checker, so planning `pytest` in a repository that does not use it produces
// a plan that can only resolve through `on_unavailable` — noise that looks
// like a finding. Every test below pins either "declared, so planned" or
// "not declared, so absent".

/** Build a throwaway component root with the given files. */
function componentRoot(files, prefix = "dotbabel-adapter-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return root;
}

function planFor(language, root, { profile = "pr", markers = ["package.json"], tools = {} } = {}) {
  return getQualityAdapter(language).plan(
    { id: `.:${language}`, root: ".", absoluteRoot: root, language, files: [], markers, tools },
    { rules: {} },
    { changedFiles: [] },
    profile,
  );
}

const withRoot = (files, prefix, run) => {
  const root = componentRoot(files, prefix);
  try { return run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

describe("python adapter — pytest and coverage (P-C2)", () => {
  it("plans pytest when pyproject.toml has tool.pytest.ini_options", () => {
    withRoot({ "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-q\"\n" }, "dotbabel-py-", (root) => {
      const test = planFor("python", root, { markers: ["pyproject.toml"] }).find((p) => p.capability === "test");
      expect(test).toBeDefined();
      expect(test.executable).toBe("pytest");
    });
  });

  it("plans pytest when pytest.ini or a root conftest.py exists", () => {
    for (const files of [{ "pytest.ini": "[pytest]\n" }, { "conftest.py": "" }, { "tox.ini": "[pytest]\n" }, { "setup.cfg": "[tool:pytest]\n" }]) {
      withRoot(files, "dotbabel-py-", (root) => {
        const test = planFor("python", root, { markers: Object.keys(files) }).find((p) => p.capability === "test");
        expect(test, `declared via ${Object.keys(files)[0]}`).toBeDefined();
      });
    }
  });

  it("runs pytest under uv run when uv.lock exists and under poetry run when poetry.lock exists", () => {
    withRoot({ "pytest.ini": "[pytest]\n", "uv.lock": "" }, "dotbabel-py-", (root) => {
      const test = planFor("python", root, { markers: ["pytest.ini"] }).find((p) => p.capability === "test");
      expect(test.executable).toBe("uv");
      expect(test.argv.slice(0, 2)).toEqual(["run", "pytest"]);
    });
    withRoot({ "pytest.ini": "[pytest]\n", "poetry.lock": "" }, "dotbabel-py-", (root) => {
      const test = planFor("python", root, { markers: ["pytest.ini"] }).find((p) => p.capability === "test");
      expect(test.executable).toBe("poetry");
      expect(test.argv.slice(0, 2)).toEqual(["run", "pytest"]);
    });
  });

  it("plans coveragepy-json coverage only when pytest-cov is a declared dependency", () => {
    const declared = "[project]\ndependencies = []\n[dependency-groups]\ndev = [\"pytest\", \"pytest-cov>=5\"]\n[tool.pytest.ini_options]\n";
    withRoot({ "pyproject.toml": declared }, "dotbabel-py-", (root) => {
      const cov = planFor("python", root, { markers: ["pyproject.toml"] }).find((p) => p.capability === "coverage");
      expect(cov).toBeDefined();
      expect(cov.report).toEqual({ format: "coveragepy-json", path: ".dotbabel/quality/coveragepy.json" });
      expect(cov.argv.join(" ")).toContain("--cov-report=json:.dotbabel/quality/coveragepy.json");
    });
    withRoot({ "pyproject.toml": "[tool.pytest.ini_options]\n" }, "dotbabel-py-", (root) => {
      expect(planFor("python", root, { markers: ["pyproject.toml"] }).some((p) => p.capability === "coverage")).toBe(false);
    });
  });

  it("prefers a quality-test Make target over the built-in pytest plan", () => {
    withRoot({ "pytest.ini": "[pytest]\n", Makefile: "quality-test:\n\t@true\n" }, "dotbabel-py-", (root) => {
      const test = planFor("python", root, { markers: ["pytest.ini"] }).find((p) => p.capability === "test");
      expect(test.executable).toBe("make");
      expect(test.argv).toEqual(["quality-test"]);
    });
  });

  it("never plans pytest when the repository declares no pytest configuration", () => {
    withRoot({ "pyproject.toml": "[project]\nname = \"x\"\n" }, "dotbabel-py-", (root) => {
      expect(planFor("python", root, { markers: ["pyproject.toml"] }).some((p) => p.capability === "test")).toBe(false);
    });
  });
});

describe("node adapter — built-in coverage (P-C3)", () => {
  const vitest = { devDependencies: { vitest: "^4", "@vitest/coverage-v8": "^4" } };

  it("plans Vitest coverage with the JSON reporter when a Vitest coverage provider is a declared dev dependency", () => {
    withRoot({ "package.json": JSON.stringify(vitest) }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov).toBeDefined();
      expect(cov.argv.join(" ")).toContain("--coverage.reporter=json");
      expect(cov.report).toEqual({ format: "istanbul-json", path: ".dotbabel/quality/coverage-final.json" });
    });
  });

  it("plans Jest coverage with the JSON reporter when Jest is a declared dev dependency", () => {
    withRoot({ "package.json": JSON.stringify({ devDependencies: { jest: "^29" } }) }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov.argv.join(" ")).toContain("--coverage");
      expect(cov.report.format).toBe("istanbul-json");
    });
  });

  it("keeps a quality:coverage or coverage script ahead of the built-in coverage plan", () => {
    for (const script of ["quality:coverage", "coverage"]) {
      withRoot({ "package.json": JSON.stringify({ ...vitest, scripts: { [script]: "vitest run --coverage" } }) }, "dotbabel-node-", (root) => {
        const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
        expect(cov.source, script).toBe("repository-script");
        expect(cov.argv).toEqual(["run", script]);
      });
    }
  });

  it("plans no coverage when no coverage provider is declared", () => {
    withRoot({ "package.json": JSON.stringify({ devDependencies: { eslint: "^9" } }) }, "dotbabel-node-", (root) => {
      expect(planFor("javascript", root).some((p) => p.capability === "coverage")).toBe(false);
    });
    // Vitest without a coverage provider cannot produce a report, so planning
    // it would only ever fail at run time.
    withRoot({ "package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }) }, "dotbabel-node-", (root) => {
      expect(planFor("javascript", root).some((p) => p.capability === "coverage")).toBe(false);
    });
  });

  it("plans coverage from the provider alone, as KD-8 specifies", () => {
    // The provider is the trigger, not `vitest` itself. In a workspace the
    // runner is often hoisted to the root or listed as a peer, and requiring
    // it here produced exactly the silent non-measurement KD-8 avoids.
    withRoot({ "package.json": JSON.stringify({ devDependencies: { "@vitest/coverage-v8": "^4" } }) }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov).toBeDefined();
      expect(cov.argv).toContain("--coverage.reporter=json");
    });
  });

  it("labels a declared-but-unproven runner as a candidate, not available", () => {
    // A manifest entry proves the package is declared, not installed, which is
    // the same evidence class the Go and Python adapters label `candidate`.
    withRoot({ "package.json": JSON.stringify(vitest) }, "dotbabel-node-", (root) => {
      expect(planFor("javascript", root).find((p) => p.capability === "coverage").availability).toBe("candidate");
    });
  });

  it("wires the built-in coverage plan into the TypeScript adapter too", () => {
    // P-C3 wires nodeBuiltinCoveragePlans into both Node adapters; without
    // this case, deleting the typescript.mjs line would fail no test.
    withRoot({ "package.json": JSON.stringify(vitest), "tsconfig.json": "{}" }, "dotbabel-ts-", (root) => {
      const cov = planFor("typescript", root, { markers: ["tsconfig.json"] }).find((p) => p.capability === "coverage");
      expect(cov).toBeDefined();
      expect(cov.report).toEqual({ format: "istanbul-json", path: ".dotbabel/quality/coverage-final.json" });
    });
  });

  it("uses pnpm exec or yarn when the matching lockfile exists", () => {
    withRoot({ "package.json": JSON.stringify(vitest), "pnpm-lock.yaml": "" }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov.executable).toBe("pnpm");
      expect(cov.argv.slice(0, 2)).toEqual(["exec", "vitest"]);
    });
    withRoot({ "package.json": JSON.stringify(vitest), "yarn.lock": "" }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov.executable).toBe("yarn");
      // `yarn exec`, not `yarn vitest`: the bare form is `yarn run vitest` on
      // Yarn 1, which would prefer a same-named package.json script.
      expect(cov.argv.slice(0, 2)).toEqual(["exec", "vitest"]);
    });
    withRoot({ "package.json": JSON.stringify(vitest) }, "dotbabel-node-", (root) => {
      const cov = planFor("javascript", root).find((p) => p.capability === "coverage");
      expect(cov.executable).toBe("npx");
    });
  });
});
