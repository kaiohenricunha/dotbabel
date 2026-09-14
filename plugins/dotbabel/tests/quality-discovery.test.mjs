import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { matchesGlob } from "../src/spec-harness-lib.mjs";
import { detectQualityCapabilities, filesMatchingQualityPaths, planQualityCheck } from "../src/quality/discovery.mjs";

const dirs = [];
function tempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-discovery-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality discovery", () => {
  it("keeps a path-triggered tool only when a changed file matches its paths", () => {
    const repoRoot = tempRepo({ "src/value.rs": "fn value() {}\n" });
    const policy = { components: [{ root: ".", languages: ["rust"], tools: {
      regression: { argv: ["cargo", "test"], paths: ["src/**"] },
    } }] };
    const detection = detectQualityCapabilities({ repoRoot, policy });
    const matching = planQualityCheck({ repoRoot, policy, profile: "pr", changeSet: { changedFiles: [{ path: "src/value.rs" }] }, detection });
    const unmatched = planQualityCheck({ repoRoot, policy, profile: "pr", changeSet: { changedFiles: [{ path: "docs/readme.md" }] }, detection });
    expect(matching.plans.find((plan) => plan.capability === "regression")).toMatchObject({ availability: "available", paths: ["src/**"] });
    expect(unmatched.plans.find((plan) => plan.capability === "regression")).toMatchObject({
      availability: "not_triggered",
      evidence: "changed files did not match: src/**",
      paths: ["src/**"],
    });
  });

  it("keeps every path-triggered tool when --all is set", () => {
    const repoRoot = tempRepo({ "src/value.rs": "fn value() {}\n" });
    const policy = { components: [{ root: ".", languages: ["rust"], tools: {
      test: { argv: ["cargo", "test"], paths: ["tests/**"] },
      regression: { argv: ["cargo", "test", "--test", "regression"], paths: ["fixtures/**"] },
    } }] };
    const planned = planQualityCheck({ repoRoot, policy, profile: "pr", changeSet: { changedFiles: [], all: true } });
    expect(planned.plans.filter((plan) => plan.paths)).toHaveLength(2);
    expect(planned.plans.filter((plan) => plan.paths).every((plan) => plan.availability === "available")).toBe(true);
  });

  it("adds every component test plan to the fast profile when a changed file matches critical_paths", () => {
    const repoRoot = tempRepo({
      "api/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "api/index.js": "export const api = true;\n",
      "web/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "web/index.js": "export const web = true;\n",
    });
    const planned = planQualityCheck({
      repoRoot,
      policy: { critical_paths: ["api/**"] },
      profile: "fast",
      changeSet: { changedFiles: [{ path: "api/index.js" }] },
    });
    expect(planned.plans.filter((plan) => plan.capability === "test").map((plan) => plan.componentId).sort()).toEqual([
      "api:javascript",
      "web:javascript",
    ]);
  });

  it("adds every component test plan to the pr and deep profiles under a --path filter when a changed file matches critical_paths", () => {
    const repoRoot = tempRepo({
      "api/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "api/index.js": "export const api = true;\n",
      "web/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "web/index.js": "export const web = true;\n",
    });
    for (const profile of ["pr", "deep"]) {
      const planned = planQualityCheck({
        repoRoot,
        policy: { critical_paths: ["api/**"] },
        profile,
        paths: ["api"],
        changeSet: { changedFiles: [{ path: "api/index.js" }] },
      });
      expect(planned.plans.filter((plan) => plan.capability === "test").map((plan) => plan.componentId).sort()).toEqual([
        "api:javascript",
        "web:javascript",
      ]);
    }
  });

  it("matches the same files as matchesGlob for generated globs and paths", () => {
    const segments = ["src", "tests", "fixtures", "nested"];
    const globs = segments.flatMap((segment) => [`${segment}/**`, `${segment}/*.js`, `**/${segment}/?.mjs`]);
    const files = segments.flatMap((segment) => [
      `${segment}/a.js`,
      `${segment}/nested/value.mjs`,
      `packages/${segment}/x.mjs`,
    ]);
    for (const glob of globs) {
      expect(filesMatchingQualityPaths(files, [glob])).toEqual(files.filter((file) => matchesGlob(glob, file)));
    }
    expect(filesMatchingQualityPaths(files, ["missing/**", "src/**"])).toEqual(["src/a.js", "src/nested/value.mjs"]);
    expect(filesMatchingQualityPaths(["src/value.js"], ["src\\**"])).toEqual(["src/value.js"]);
    expect(filesMatchingQualityPaths()).toEqual([]);
    expect(filesMatchingQualityPaths(files)).toEqual([]);
  });

  it("matches 10000 changed files against 50 globs in under 500 milliseconds", () => {
    const files = Array.from({ length: 10_000 }, (_, index) => `packages/p${index % 100}/src/file-${index}.mjs`);
    const globs = Array.from({ length: 50 }, (_, index) => `packages/p${index}/tests/**`);
    const started = performance.now();
    expect(filesMatchingQualityPaths(files, globs)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("finds several languages and nested components", () => {
    const repoRoot = tempRepo({
      "api/go.mod": "module example/api\n",
      "api/main.go": "package main\n",
      "worker/pyproject.toml": "[project]\nname='worker'\n",
      "worker/main.py": "print('x')\n",
      "web/tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false } }),
      "web/src/a.ts": "export const a = 1;\n",
      "web/src/plain.js": "export const b = 2;\n",
    });
    const result = detectQualityCapabilities({ repoRoot });
    expect(result.components.map((item) => `${item.root}:${item.language}`)).toEqual(expect.arrayContaining(["api:go", "worker:python", "web:typescript", "web:javascript"]));
  });

  it("gives TypeScript ownership of only JavaScript files that opt in", () => {
    const repoRoot = tempRepo({
      "web/tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false, checkJs: false } }),
      "web/src/checked.js": "// @ts-check\nexport const checked = true;\n",
      "web/src/plain.js": "export const plain = true;\n",
      "web/src/value.ts": "export const value = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot });
    const typescript = result.components.find((item) => item.id === "web:typescript");
    const javascript = result.components.find((item) => item.id === "web:javascript");
    expect(typescript.files).toContain("web/src/checked.js");
    expect(typescript.files).not.toContain("web/src/plain.js");
    expect(javascript.files).toContain("web/src/plain.js");
    expect(javascript.files).not.toContain("web/src/checked.js");
  });

  it("keeps all discovery evidence for one root and language", () => {
    const repoRoot = tempRepo({
      "web/tsconfig.json": "{}\n",
      "web/tsconfig.build.json": "{}\n",
      "web/src/value.ts": "export const value = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot });
    expect(result.components.find((item) => item.id === "web:typescript").markers).toEqual([
      "web/tsconfig.json",
      "web/tsconfig.build.json",
    ]);
  });

  it("merges explicit component overrides and reports unknown languages", () => {
    const repoRoot = tempRepo({ "Cargo.toml": "[package]\nname='x'\n", "src/x.rs": "fn main() {}\n" });
    const result = detectQualityCapabilities({
      repoRoot,
      policy: { components: [{ root: ".", languages: ["rust"], tools: {} }] },
    });
    expect(result.components[0].language).toBe("rust");
    expect(result.components[0].state).toBe("unsupported");
  });

  it("maps generic configured tools to language-independent rules", () => {
    const repoRoot = tempRepo({ "src/x.rs": "fn main() {}\n" });
    const policy = {
      components: [{ root: ".", languages: ["rust"], tools: { lint: { argv: ["cargo", "clippy"] } } }],
    };
    const detection = detectQualityCapabilities({ repoRoot, policy });
    const result = planQualityCheck({ repoRoot, policy, profile: "fast", changeSet: { changedFiles: [] }, detection });
    expect(result.plans).toEqual([{
      id: ".:rust:lint",
      componentId: ".:rust",
      capability: "lint",
      ruleIds: ["correctness.lint"],
      executable: "cargo",
      argv: ["clippy"],
      cwd: repoRoot,
      timeoutSeconds: undefined,
      report: undefined,
      paths: undefined,
      availability: "available",
      source: "project",
      requiresTrust: true,
    }]);
  });

  it("returns the exact configured component contract for an unknown language", () => {
    const repoRoot = tempRepo({ "src/x.rs": "fn main() {}\n" });
    const tools = { lint: { argv: ["cargo", "clippy"], report: { format: "exit-code" } } };
    const result = detectQualityCapabilities({
      repoRoot,
      policy: { components: [{ root: ".", languages: ["rust"], tools }] },
    });
    expect(result.files).toEqual(["src/x.rs"]);
    expect(result.exclusions).toEqual([]);
    expect(result.components).toEqual([{
      root: ".",
      language: "rust",
      markers: [],
      configured: true,
      tools,
      id: ".:rust",
      absoluteRoot: repoRoot,
      files: ["src/x.rs"],
      state: "checked",
      evidence: [],
    }]);
  });

  it("reads JSON comments for JavaScript ownership and limits @ts-check to the file header", () => {
    const repoRoot = tempRepo({
      "web/tsconfig.json": "/* remove this comment */\n{\n// and this one\n\"compilerOptions\": { \"allowJs\": true }\n}\n",
      "web/src/owned.js": "export const owned = true;\n",
      "web/src/late.js": "\n\n\n\n\n// @ts-check\nexport const late = true;\n",
      "plain/tsconfig.json": "{}\n",
      "plain/string.js": "const marker = \"// @ts-check\";\n",
    });
    const result = detectQualityCapabilities({ repoRoot });
    expect(result.components.find((item) => item.id === "web:typescript").files).toContain("web/src/owned.js");
    expect(result.components.find((item) => item.id === "plain:typescript").files).not.toContain("plain/string.js");
    expect(result.components.find((item) => item.id === "plain:javascript").files).toContain("plain/string.js");
  });

  it("does not escalate tests when no changed file matches critical_paths", () => {
    const repoRoot = tempRepo({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "index.js": "export const value = true;\n",
    });
    const planned = planQualityCheck({
      repoRoot,
      policy: { critical_paths: ["critical/**"] },
      profile: "fast",
      changeSet: { changedFiles: [{ path: "index.js" }] },
    });
    expect(planned.criticalMatches).toEqual([]);
    expect(planned.plans.some((plan) => plan.capability === "test")).toBe(false);
  });

  it("counts files outside the path filter as a visible exclusion", () => {
    const repoRoot = tempRepo({
      "src/live.js": "export const live = true;\n",
      "web/other.js": "export const other = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot, policy: {}, paths: ["src"] });
    expect(result.files).toContain("src/live.js");
    expect(result.files).not.toContain("web/other.js");
    expect(result.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "outside path filter", count: 1 })]));
    expect(result.paths).toEqual(["src"]);
  });

  it("matches a directory name without a trailing glob", () => {
    const repoRoot = tempRepo({ "src/quality/a.js": "export const a = 1;\n", "src/other/b.js": "export const b = 2;\n" });
    const result = detectQualityCapabilities({ repoRoot, policy: {}, paths: ["src/quality"] });
    expect(result.files).toEqual(["src/quality/a.js"]);
  });

  it("keeps a policy exclusion authoritative inside the path filter", () => {
    const repoRoot = tempRepo({ "src/live.js": "export const live = true;\n", "src/legacy/x.js": "// @generated\nexport const x = 1;\n" });
    const result = detectQualityCapabilities({ repoRoot, policy: { exclude: ["src/legacy/**"] }, paths: ["src"] });
    expect(result.files).toEqual(["src/live.js"]);
    expect(result.exclusions).toEqual([{ reason: "policy pattern src/legacy/**", count: 1 }]);
  });

  it("cannot re-include a file the policy excludes", () => {
    const repoRoot = tempRepo({ "fixtures/skip.js": "export const skip = true;\n" });
    const result = detectQualityCapabilities({ repoRoot, policy: { exclude: ["fixtures/**"] }, paths: ["fixtures"] });
    expect(result.files).toEqual([]);
  });

  it("drops plans for components with no file inside the path filter", () => {
    const repoRoot = tempRepo({
      "api/go.mod": "module example.com/api\n",
      "api/main.go": "package main\n",
      "web/package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "web/index.js": "export const web = 1;\n",
    });
    const planned = planQualityCheck({ repoRoot, policy: {}, changeSet: { changedFiles: [] }, profile: "fast", paths: ["api"] });
    expect(planned.plans.length).toBeGreaterThan(0);
    expect(planned.plans.every((plan) => plan.componentId.startsWith("api"))).toBe(true);
  });

  it("keeps every plan when no path filter is supplied", () => {
    const repoRoot = tempRepo({
      "api/go.mod": "module example.com/api\n",
      "api/main.go": "package main\n",
      "web/package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "web/index.js": "export const web = 1;\n",
    });
    const planned = planQualityCheck({ repoRoot, policy: {}, changeSet: { changedFiles: [] }, profile: "fast" });
    expect(planned.plans.some((plan) => plan.componentId.startsWith("web"))).toBe(true);
  });

  it("excludes configured and generated files with visible reasons", () => {
    const repoRoot = tempRepo({
      "package.json": "{}\n",
      "src/live.js": "export const live = true;\n",
      "src/generated.js": "// @generated\nexport const made = true;\n",
      "src/late-marker.js": "one\ntwo\nthree\n// @generated\n",
      "src/split-marker.js": "// Code generated across\n// several words before DO NOT EDIT\n",
      "fixtures/skip.js": "export const skip = true;\n",
      "templates/keep.js": "export const keep = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot, policy: { exclude: ["fixtures/**"] } });
    expect(result.files).toContain("templates/keep.js");
    expect(result.files).toContain("src/late-marker.js");
    expect(result.files).toContain("src/split-marker.js");
    expect(result.files).not.toContain("src/generated.js");
    expect(result.files).not.toContain("fixtures/skip.js");
    expect(result.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "generated marker", count: 1 }),
      expect.objectContaining({ reason: "policy pattern fixtures/**", count: 1 }),
    ]));
  });

  it("assigns same-language files to the nearest configured component", () => {
    const repoRoot = tempRepo({
      "package.json": "{}\n",
      "root.js": "export const root = true;\n",
      "web/package.json": "{}\n",
      "web/index.js": "export const web = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot, policy: { components: [
      { root: ".", languages: ["javascript"] },
      { root: "web", languages: ["javascript"] },
    ] } });
    expect(result.components.map((item) => item.id)).toEqual([".:javascript", "web:javascript"]);
    expect(result.components.find((item) => item.id === ".:javascript").files).toEqual(["package.json", "root.js"]);
    expect(result.components.find((item) => item.id === "web:javascript").files).toEqual(["web/index.js", "web/package.json"]);
  });

  it("recognizes JavaScript module extensions without claiming source-map names", () => {
    const repoRoot = tempRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true } }),
      "src/common.cjs": "module.exports = true;\n",
      "src/module.mjs": "export default true;\n",
      "src/plain.js": "export default true;\n",
      "src/plain.js.map": "{}\n",
    });
    const result = detectQualityCapabilities({ repoRoot });
    expect(result.components.find((item) => item.id === ".:typescript").files).toEqual([
      "src/common.cjs",
      "src/module.mjs",
      "src/plain.js",
      "src/plain.js.map",
      "tsconfig.json",
    ]);
  });

  it("uses explicit critical matches even when the scoped change set is empty", () => {
    const repoRoot = tempRepo({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "index.js": "export const value = true;\n",
    });
    const planned = planQualityCheck({
      repoRoot,
      policy: { critical_paths: ["critical/**"] },
      profile: "fast",
      changeSet: { changedFiles: [], criticalMatches: ["critical/outside.js"] },
    });
    expect(planned.criticalMatches).toEqual(["critical/outside.js"]);
    expect(planned.plans.filter((plan) => plan.capability === "test")).toHaveLength(1);
  });

  it("keeps only tests outside a --path scope during critical escalation", () => {
    const repoRoot = tempRepo({
      "api/package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }),
      "api/index.js": "export const api = true;\n",
      "web/package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }),
      "web/index.js": "export const web = true;\n",
    });
    const planned = planQualityCheck({
      repoRoot,
      policy: { critical_paths: ["api/**"] },
      profile: "fast",
      paths: ["api"],
      changeSet: { changedFiles: [{ path: "api/index.js" }] },
    });
    expect(planned.plans.filter((plan) => plan.componentId === "web:javascript").map((plan) => plan.capability)).toEqual(["test"]);
    expect(planned.plans.filter((plan) => plan.componentId === "api:javascript").map((plan) => plan.capability).sort()).toEqual(["compile", "lint", "test"]);
  });

  it("escalates generic component tests without widening other generic tools", () => {
    const repoRoot = tempRepo({
      "api/value.rs": "fn api() {}\n",
      "web/value.rs": "fn web() {}\n",
    });
    const policy = {
      critical_paths: ["api/**"],
      components: ["api", "web"].map((root) => ({ root, languages: ["rust"], tools: {
        lint: { argv: ["cargo", "clippy"] },
        test: { argv: ["cargo", "test"] },
      } })),
    };
    const planned = planQualityCheck({
      repoRoot,
      policy,
      profile: "fast",
      paths: ["api"],
      changeSet: { changedFiles: [{ path: "api/value.rs" }] },
    });
    expect(planned.plans.map((plan) => `${plan.componentId}:${plan.capability}`).sort()).toEqual([
      "api:rust:lint",
      "api:rust:test",
      "web:rust:test",
    ]);

    const ordinary = planQualityCheck({
      repoRoot,
      policy,
      profile: "fast",
      changeSet: { changedFiles: [{ path: "web/value.rs" }] },
    });
    expect(ordinary.plans.map((plan) => plan.capability)).toEqual(["lint", "lint"]);
  });

  it("does not plan another language's Make target for a stray-source component", () => {
    // #337: the stray .py file is tooling, not a Python project.
    const repoRoot = tempRepo({
      "Makefile": "lint:\n\tcd api && golangci-lint run ./...\ntest:\n\tcd api && go test ./...\n",
      "api/go.mod": "module example/api\n",
      "api/main.go": "package main\n",
      "tools/render/helper.py": "x = 1\n",
    });
    const detection = detectQualityCapabilities({ repoRoot });
    expect(detection.components.find((item) => item.id === ".:python")?.markers).toEqual([]);
    const plans = planQualityCheck({ repoRoot, profile: "pr", changeSet: { changedFiles: [] }, detection }).plans;
    expect(plans.filter((plan) => plan.componentId === ".:python" && plan.executable === "make")).toEqual([]);
  });
});
