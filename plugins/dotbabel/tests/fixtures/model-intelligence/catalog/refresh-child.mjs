/**
 * One contender of the TEST-8 torture test in `model-intelligence-catalog.test.mjs`.
 *
 * argv: <cache root> <discovery counter file> <go file> <ready file>. The child signals that it is
 * ready, waits for the go file so every contender tries the lock at nearly the same moment, then runs
 * one refresh of the `torture` key. Its discovery appends a line to the counter and holds the lock
 * for a second, so a contender that does not wait for the lock would add a second line.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { refreshSource } from "../../../../src/model-intelligence/catalog/index.mjs";
import { makeAdapterResult } from "../../../../src/model-intelligence/sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../../../../src/model-intelligence/sources/evidence.mjs";

const [root, counter, go, ready] = process.argv.slice(2);
writeFileSync(ready, "");
while (!existsSync(go)) await sleep(5);

const module = {
  descriptor: { id: "torture", kind: "runtime", capabilities: { discovery: { support: "supported", network: "never", auth: "none", cacheable: true, execution: "read-only" } } },
  ADAPTER_VERSION: "1",
  async discover() {
    appendFileSync(counter, `${process.pid}\n`);
    await sleep(1000);
    return makeAdapterResult({
      status: "ok",
      evidence: makeDiscoveryEvidence({ models: [makeModelFact({ id: "m", supportedReasoningLevels: [] })] }),
      provenance: { sourceId: "torture", sourceKind: "runtime", adapterVersion: "1" },
      observedAt: new Date().toISOString(),
    });
  },
};

const outcome = await refreshSource({ module }, { root });
process.stdout.write(JSON.stringify({ outcome: outcome.outcome }));
