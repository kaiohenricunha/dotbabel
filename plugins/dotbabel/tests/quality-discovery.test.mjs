import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectQualityCapabilities, planQualityCheck } from "../src/quality/discovery.mjs";

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
    expect(result.plans[0].ruleIds).toEqual(["correctness.lint"]);
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
    const repoRoot = tempRepo({ "src/live.js": "export const live = true;\n", "src/legacy/x.js": "export const x = 1;\n" });
    const result = detectQualityCapabilities({ repoRoot, policy: { exclude: ["src/legacy/**"] }, paths: ["src"] });
    expect(result.files).toEqual(["src/live.js"]);
    expect(result.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "policy pattern src/legacy/**" })]));
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
      "fixtures/skip.js": "export const skip = true;\n",
      "templates/keep.js": "export const keep = true;\n",
    });
    const result = detectQualityCapabilities({ repoRoot, policy: { exclude: ["fixtures/**"] } });
    expect(result.files).toContain("templates/keep.js");
    expect(result.files).not.toContain("src/generated.js");
    expect(result.files).not.toContain("fixtures/skip.js");
    expect(result.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "generated marker", count: 1 }),
      expect.objectContaining({ reason: "policy pattern fixtures/**", count: 1 }),
    ]));
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
