/** Explicit deterministic materialization input for tests and the public feature smoke. */
import { resolve } from "../../../src/model-intelligence/resolver/index.mjs";
import { input } from "./resolver.mjs";

export function materializationFixture() {
  const resolverInput = input();
  return { toolVersion: "4.2.0", artifacts: [{
    sourcePath: "agents/example.md",
    sourceContent: "---\nname: example\ndescription: A verified agent.\nowner: private-owner\ndotbabel:\n  compute:\n    requirement: deep\n    mode: dynamic\n    binding: self\n---\n\nKeep this body exactly.\n",
    target: { path: "agents/example.md", runtimeId: "codex", artifactKind: "agent" },
    requirement: resolverInput.requirement,
    policy: resolverInput.policy,
    resolverResult: structuredClone(resolve(resolverInput)),
    runtimeContract: resolverInput.runtimeContract,
    capabilityEvidence: { sourceId: "fixture", observedAt: "2026-01-01T00:00:00Z", facts: { tool_call: true } },
    projectionContract: { frontmatterKeys: ["name", "description", "model", "effort"], axisKeys: { model: "model", reasoning: "effort" } },
    snapshotId: null,
  }] };
}
