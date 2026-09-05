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
});
