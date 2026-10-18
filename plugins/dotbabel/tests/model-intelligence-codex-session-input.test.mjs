import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSessionInputLoader } from "../src/model-intelligence/cli/codex-session-input.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../src/model-intelligence/sources/evidence.mjs";
const roots = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = floor => { const directory = mkdtempSync(join(tmpdir(), "mi-session-policy-")); roots.push(directory); writeFileSync(join(directory, ".dotbabel.json"), JSON.stringify({ model_intelligence: { floor: { mode: "floor", requirement: floor } } })); return directory; };
const discovered = observedAt => makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: "fixture" }, observedAt, evidence: makeDiscoveryEvidence({ models: ["visible", "hidden", "unknown"].map(id => makeModelFact({ id, supportedReasoningLevels: [] })) }) });
it("loads each caller's project policy without leaking it through shared capability facts", async () => {
  const a = root("deep"), b = root("frontier"), now = "2026-10-18T00:00:00.000Z";
  const discover = vi.fn(async () => discovered(now));
  const rpc = { request: vi.fn(async (method, params) => {
    expect(method).toBe("model/list"); expect(params).toEqual({ includeHidden: true });
    return { data: [{ model: "visible", hidden: false }, { model: "hidden", hidden: true }, { model: "unknown" }] };
  }) };
  const load = createCodexSessionInputLoader({ rpc, discover, now: () => now });
  const [first, second] = await Promise.all([load(a), load(b)]);
  expect(discover.mock.calls.map(([input]) => input.cwd).sort()).toEqual([a, b].sort());
  expect(first.policy.floor.requirement).toBe("deep"); expect(second.policy.floor.requirement).toBe("frontier");
  for (const input of [first, second]) {
    expect(input.target).toEqual({ runtimeId: "codex", artifactKind: "workflow" });
    expect(input.runtimeContract.id).toBe("codex");
    expect(input.catalog.runtimes[0].models.map(model => model.model)).toEqual(["visible", "hidden", "unknown"]);
    expect(input.catalog.runtimes[0].models[1].fields.selectionVisibility[0].value).toBe("hidden");
    expect(input.catalog.runtimes[0].models[2].fields.selectionVisibility[0].value).toBe("unknown");
    expect(input.catalog.runtimes[0].models[0].fields.id[0]).toMatchObject({ freshness: "fresh", refresh: "idle" });
  }
});
it("uses the actual clock by default and refreshes expired evidence without caching a failed refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
  const repoRoot = root("routine"), discover = vi.fn(async () => discovered(new Date().toISOString()));
  const rpc = { request: vi.fn(async () => ({ data: [{ model: "visible", hidden: false }] })) };
  const load = createCodexSessionInputLoader({ rpc, discover });
  await load(repoRoot); await load(repoRoot); expect(discover).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
  discover.mockResolvedValueOnce({ status: "unavailable" });
  await expect(load(repoRoot)).rejects.toMatchObject({ code: "capability_evidence_unavailable", message: "capability_evidence_unavailable" });
  const refreshed = await load(repoRoot); expect(discover).toHaveBeenCalledTimes(3); expect(rpc.request).toHaveBeenCalledTimes(3);
  expect(refreshed.catalog.runtimes[0].models[0].fields.id[0].freshness).toBe("fresh");
});
it("retains a hidden manual model's capability facts so the public resolver rejects a lower-floor pin", async () => {
 const {resolve}=await import("../src/model-intelligence/resolver/index.mjs");
 const repoRoot=root("frontier"),now="2026-10-18T00:00:00.000Z";
 const discover=async()=>makeAdapterResult({status:"ok",provenance:{sourceId:"codex",sourceKind:"runtime",adapterVersion:"fixture"},observedAt:now,evidence:makeDiscoveryEvidence({models:[makeModelFact({id:"hidden",selectionVisibility:"hidden",supportedReasoningLevels:[],capabilities:{reasoning:false,tool_call:true}}),makeModelFact({id:"visible",selectionVisibility:"listed",supportedReasoningLevels:[{effort:"calm"},{effort:"focused"},{effort:"thorough"}],capabilities:{reasoning:true,tool_call:true}})]})});
 const load=createCodexSessionInputLoader({discover,now:()=>now,rpc:{request:async()=>({data:[{model:"visible",hidden:false},{model:"hidden",hidden:true}]})}});
 const input=await load(repoRoot);
 const result=resolve({...input,requirement:{mode:"dynamic",requirement:"routine",binding:"self",provenance:{sourceId:"fixture",sourceKind:"artifact"}},invocation:{pin:{runtime:"codex",config:{model:"hidden"}},omitDefaultReasoning:true}});
 expect(result.status).toBe("conflict");expect(result.diagnostics.map(x=>x.code)).toContain("pin_floor_conflict");
 const ordinary=resolve({...input,requirement:{mode:"dynamic",requirement:"routine",binding:"self",provenance:{sourceId:"fixture",sourceKind:"artifact"}}});
 expect(ordinary.configuration.axes.model).toBe("visible");
});
