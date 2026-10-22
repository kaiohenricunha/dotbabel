import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { resolveRequest } from "../src/model-intelligence/cli/resolve.mjs";
import { makeCacheEntry, writeEntry, cacheRoot } from "../src/model-intelligence/catalog/cache.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeModelFact, makeDiscoveryEvidence } from "../src/model-intelligence/sources/evidence.mjs";
import { ADAPTER_VERSION } from "../src/model-intelligence/sources/runtime/codex.mjs";

function fixture() {
  const repoRoot = makeTempDir("mi-resolve-request-");
  vi.stubEnv("XDG_CACHE_HOME", join(repoRoot, "cache"));
  vi.stubEnv("XDG_CONFIG_HOME", join(repoRoot, "config"));
  writeFileSync(join(repoRoot, ".dotbabel.json"), "{}");
  const model = makeModelFact({ id: "opaque-request-model", selectionVisibility: "listed", capabilities: { reasoning: true, tool_call: true }, supportedReasoningLevels: [{ effort: "native-low" }, { effort: "native-high" }], defaultReasoningLevel: "native-low" });
  const result = makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: ADAPTER_VERSION }, observedAt: new Date().toISOString(), evidence: makeDiscoveryEvidence({ models: [model] }) });
  expect(writeEntry(cacheRoot(), makeCacheEntry({ result })).written).toBe(true);
  const request = { repoRoot, runtimeId: "codex", artifactKind: "skill", workloadClass: "deep" };
  const artifact = text => { writeFileSync(join(repoRoot, "artifact.md"), text); return { ...request, workloadClass: undefined, artifactPath: "artifact.md" }; };
  return { repoRoot, request, artifact };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("read-only resolution file boundaries", () => {
  it("loads explicit requirements and project policy without making a network call", () => {
    const { request } = fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected network"); });
    const value = resolveRequest(request);
    expect(value.exitCode).toBe(0);
    expect(value.result.configuration.axes).toEqual({ model: "opaque-request-model", reasoning: "native-low" });
    expect(value.context.requirement).toMatchObject({ requirement: "deep", binding: "consumer", mode: "dynamic" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads a canonical artifact and retains its original contents", () => {
    const { repoRoot, artifact } = fixture();
    const text = "---\ndotbabel:\n  compute:\n    requirement: deep\n    mode: floor\n    binding: consumer\n---\nOriginal body.\n";
    const value = resolveRequest(artifact(text));
    expect(value).toMatchObject({ exitCode: 0, result: { status: "resolved" }, context: { requirement: { requirement: "deep", mode: "floor", provenance: { derivation: "declared" } } } });
    expect(readFileSync(join(repoRoot, "artifact.md"), "utf8")).toBe(text);
  });
  it("derives legacy meaning without rewriting or approving a migration", () => {
    const { artifact } = fixture();
    const value = resolveRequest(artifact("---\nmodel: sonnet\n---\n"));
    expect(value).toMatchObject({ exitCode: 0, result: { status: "resolved" }, context: { requirement: { mode: "floor", provenance: { derivation: "legacy-inferred" } } } });
  });
  it("preserves inheritance when no declaration exists", () => {
    const { artifact } = fixture();
    const value = resolveRequest(artifact("Plain body with no compute declaration."));
    expect(value.result.status).toBe("unresolved");
    expect(value.result.diagnostics.map(x => x.code)).toContain("runtime_inheritance_preserved");
  });
  it.each(["---\ndotbabel: [\n---\n", "---\ndotbabel: {}\n", "---\n- not-a-mapping\n---\n"])("rejects malformed frontmatter without reporting private input", text => {
    const { artifact } = fixture();
    const value = resolveRequest(artifact(text));
    expect(value).toMatchObject({ exitCode: 1, result: { status: "invalid", diagnostics: [{ code: "invalid_artifact_frontmatter" }] } });
  });
  it("never falls back when canonical data is invalid or conflicts with legacy data", () => {
    const { artifact } = fixture();
    const invalid = resolveRequest(artifact("---\nmodel: sonnet\ndotbabel:\n  compute: private-parse-marker\n---\n"));
    expect(invalid).toMatchObject({ exitCode: 1, result: { status: "invalid", diagnostics: [{ code: "MI_COMPUTE_INVALID" }] } });
    expect(JSON.stringify(invalid)).not.toContain("private-parse-marker");
    const conflict = resolveRequest(artifact("---\nmodel: haiku\ndotbabel:\n  compute:\n    requirement: frontier\n    mode: pin\n    binding: consumer\n    rationale: Preserve an explicit native choice.\n    pin:\n      runtime: claude\n      config:\n        model: sonnet\n---\n"));
    expect(conflict).toMatchObject({ exitCode: 1, result: { status: "conflict", diagnostics: [{ code: "MI_DUAL_DECLARATION_CONFLICT" }] } });
  });
  it("does not guess a requirement for ambiguous legacy effort metadata", () => {
    const { artifact } = fixture();
    const value = resolveRequest(artifact("---\neffort: high\n---\n"));
    expect(value).toMatchObject({ exitCode: 1, result: { status: "unresolved", diagnostics: [{ code: "legacy_requirement_ambiguous" }] } });
  });
  it("rejects missing, non-file and oversized inputs with environment diagnostics", () => {
    const { repoRoot, request, artifact } = fixture();
    const missing = resolveRequest({ ...request, artifactPath: "missing.md" });
    expect(missing).toMatchObject({ exitCode: 2, result: { diagnostics: [{ code: "artifact_unavailable" }] } });
    mkdirSync(join(repoRoot, "directory.md"));
    expect(resolveRequest({ ...request, artifactPath: "directory.md" }).exitCode).toBe(2);
    expect(resolveRequest(artifact("x".repeat(1024 * 1024 + 1))).exitCode).toBe(2);
  });
  it("accepts the maximum artifact size with the original canonical declaration", () => {
    const { artifact } = fixture();
    const header = "---\ndotbabel:\n  compute:\n    requirement: deep\n    mode: dynamic\n    binding: consumer\n---\n";
    const value = resolveRequest(artifact(header + "x".repeat(1024 * 1024 - Buffer.byteLength(header))));
    expect(value).toMatchObject({ exitCode: 0, result: { status: "resolved" } });
  });
  it("reports malformed policy without echoing its contents", () => {
    const { repoRoot, request } = fixture();
    writeFileSync(join(repoRoot, ".dotbabel.json"), '{"private-policy-marker":');
    const value = resolveRequest(request);
    expect(value).toMatchObject({ exitCode: 1, result: { status: "invalid", diagnostics: [{ code: "invalid_model_intelligence_policy" }] } });
    expect(JSON.stringify(value)).not.toContain("private-policy-marker");
  });
  it("rejects a repository class-table override instead of redefining the user's floor", () => {
    const { repoRoot, request } = fixture();
    mkdirSync(join(repoRoot, "config", "dotbabel"), { recursive: true });
    writeFileSync(join(repoRoot, "config", "dotbabel", "model-intelligence.json"), JSON.stringify({ floor: { mode: "floor", requirement: "frontier" } }));
    expect(resolveRequest(request).result.status).toBe("unresolved");
    writeFileSync(join(repoRoot, ".dotbabel.json"), JSON.stringify({ model_intelligence: { classes: { frontier: { satisfied_by: {} } } } }));
    const value = resolveRequest(request);
    expect(value).toMatchObject({ exitCode: 1, result: { status: "invalid", diagnostics: [{ code: "invalid_model_intelligence_policy" }] } });
    expect(value.result.configuration).toBeUndefined();
  });
  it("reports unsupported runtime adapters without pretending that a catalog can enable them", () => {
    const { request } = fixture();
    const value = resolveRequest({ ...request, runtimeId: "antigravity" });
    expect(value).toMatchObject({ exitCode: 2, result: { status: "unresolved", diagnostics: [{ code: "runtime_adapter_unavailable" }] } });
    // Gemini has an adapter, but it cannot discover models, so no catalog evidence exists for it.
    expect(resolveRequest({ ...request, runtimeId: "gemini" })).toMatchObject({ exitCode: 2, result: { status: "unresolved", diagnostics: [{ code: "insufficient_capability_evidence" }] } });
  });
});
