/** Offline CLI fixture: opaque identities and explicit capability evidence. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCacheEntry, writeEntry, cacheRoot } from "../../../src/model-intelligence/catalog/cache.mjs";
import { makeAdapterResult } from "../../../src/model-intelligence/sources/contract.mjs";
import { makeModelFact, makeDiscoveryEvidence } from "../../../src/model-intelligence/sources/evidence.mjs";
import { ADAPTER_VERSION } from "../../../src/model-intelligence/sources/runtime/codex.mjs";
const [repo, mode] = process.argv.slice(2);
const conflict = mode === "conflict";
const config = conflict ? { model_intelligence: { floor: { mode: "floor", requirement: "frontier" }, pin: { mode: "pin", runtime: "codex", config: { model: "opaque-cli-model" } } } } : {};
writeFileSync(join(repo, ".dotbabel.json"), JSON.stringify(config));
const models = [makeModelFact({ id: "opaque-cli-model", capabilities: { reasoning: !conflict, tool_call: true }, supportedReasoningLevels: conflict ? [] : [{ effort: "native-low" }, { effort: "native-high" }], ...(!conflict ? { defaultReasoningLevel: "native-low" } : {}) })];
const result = makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: ADAPTER_VERSION }, observedAt: new Date().toISOString(), evidence: makeDiscoveryEvidence({ models }) });
if (!writeEntry(cacheRoot(), makeCacheEntry({ result })).written) throw new Error("fixture cache unavailable");
