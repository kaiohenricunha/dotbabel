import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { makeCacheEntry, writeEntry, cacheRoot, entryPath } from "../src/model-intelligence/catalog/cache.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeModelFact, makeDiscoveryEvidence } from "../src/model-intelligence/sources/evidence.mjs";
import { ADAPTER_VERSION } from "../src/model-intelligence/sources/runtime/codex.mjs";

const bin = fileURLToPath(new URL("../bin/dotbabel-models.mjs", import.meta.url));
function fixture({ seed = true, reasoning = true, project = {} } = {}) {
  const repo = makeTempDir("mi-resolve-cli-");
  const env = { ...process.env, XDG_CACHE_HOME: join(repo, "cache"), XDG_CONFIG_HOME: join(repo, "config") };
  writeFileSync(join(repo, ".dotbabel.json"), JSON.stringify(project));
  if (seed) {
    const result = makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: ADAPTER_VERSION }, observedAt: new Date().toISOString(), evidence: makeDiscoveryEvidence({ models: [makeModelFact({ id: "opaque-cli-model", capabilities: { reasoning, tool_call: true }, supportedReasoningLevels: reasoning ? [{ effort: "native-low" }, { effort: "native-middle" }] : [], ...(reasoning ? { defaultReasoningLevel: "native-middle" } : {}) })] }) });
    expect(writeEntry(cacheRoot(env), makeCacheEntry({ result })).written).toBe(true);
  }
  const run = (...args) => spawnSync(process.execPath, [bin, "resolve", ...args, "--repo-root", repo, "--json"], { cwd: repo, env, encoding: "utf8", timeout: 15000 });
  return { repo, env, run };
}

describe("models resolve CLI", () => {
  it("prints the shared ResolverResult from cached evidence without refreshing or writing", () => {
    const { repo, env, run } = fixture();
    const cache = entryPath(cacheRoot(env), "codex");
    const before = readFileSync(cache, "utf8");
    const project = readFileSync(join(repo, ".dotbabel.json"), "utf8");
    const result = run("--runtime", "codex", "--requirement", "deep");
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({ status: "resolved", configuration: { runtimeId: "codex", axes: { model: "opaque-cli-model", reasoning: "native-middle" } }, enforcement: { state: "unknown" } });
    expect(value.explanation.length).toBeGreaterThan(0);
    expect(readFileSync(cache, "utf8")).toBe(before);
    expect(readFileSync(join(repo, ".dotbabel.json"), "utf8")).toBe(project);
    expect(readdirSync(cacheRoot(env))).toEqual(["entries"]);
  });
  it("emits a ResolverResult and exits 1 when a project pin violates the floor", () => {
    const { run } = fixture({ reasoning: false, project: { model_intelligence: { floor: { mode: "floor", requirement: "frontier" }, pin: { mode: "pin", runtime: "codex", config: { model: "opaque-cli-model" } } } } });
    const result = run("--runtime", "codex", "--requirement", "deep");
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "conflict", enforcement: { state: "unsatisfied" } });
  });
  it("reports unavailable local evidence with exit 2 and creates no cache", () => {
    const { repo, run } = fixture({ seed: false });
    const result = run("--runtime", "codex", "--requirement", "deep");
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe("unresolved");
    expect(readdirSync(repo)).toEqual([".dotbabel.json"]);
  });
  it("resolves a canonical artifact with declared provenance and leaves its bytes unchanged", () => {
    const { repo, run } = fixture();
    const text = "---\ndotbabel:\n  compute:\n    requirement: deep\n    mode: floor\n    binding: consumer\n---\nUser-owned body.\n";
    writeFileSync(join(repo, "artifact.md"), text);
    const result = run("artifact.md", "--runtime", "codex", "--artifact-kind", "skill");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "resolved", enforcement: { state: "unknown" } });
    expect(readFileSync(join(repo, "artifact.md"), "utf8")).toBe(text);
  });
  it("reports invalid artifact declarations as data errors and does not fall back to legacy metadata", () => {
    const { repo, run } = fixture();
    writeFileSync(join(repo, "artifact.md"), "---\nmodel: opus\ndotbabel:\n  compute: invalid-private-marker\n---\n");
    const result = run("artifact.md", "--runtime", "codex");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("invalid");
    expect(result.stdout + result.stderr).not.toContain("invalid-private-marker");
  });
  it("keeps rejected opaque pin values out of human diagnostics", () => {
    const { repo, env } = fixture({ project: { model_intelligence: { pin: { mode: "pin", runtime: "codex", config: { model: "opaque-cli-model", apiKey: "private-pin-marker" } } } } });
    const result = spawnSync(process.execPath, [bin, "resolve", "--runtime", "codex", "--requirement", "deep", "--repo-root", repo, "--no-color"], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("private-pin-marker");
  });
  it("rejects malformed ad hoc usage with exit 64", () => {
    const { run } = fixture({ seed: false });
    for (const args of [["--runtime", "codex"], ["--requirement", "deep"], ["--runtime", "unknown", "--requirement", "deep"], ["--runtime", "codex", "--requirement", "genius"], ["artifact.md", "--runtime", "codex", "--requirement", "deep"], ["--runtime", "codex", "--requirement", "deep", "--artifact-kind", "invalid"]]) {
      const result = run(...args);
      expect(result.status, JSON.stringify(args) + result.stderr).toBe(64);
    }
  });
});
