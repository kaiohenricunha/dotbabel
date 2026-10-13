// Network integration (TEST-5, the P-8 row): claims about the LIVE Models.dev document that the
// recorded fixture cannot prove, such as the shape still matching and the reduction still fitting.
//
// Run with DOTBABEL_MODELS_DEV_INTEGRATION=1. This is a network test, separate from the runtime
// integration tests that DOTBABEL_MODELS_INTEGRATION gates. Without it every test below is reported
// as skipped, never as a silent pass. No credential is sent: the source needs none (SEC-3).

import { describe, it, expect } from "vitest";
import * as modelsDev from "../../src/model-intelligence/sources/knowledge/models-dev.mjs";

const runnable = describe.skipIf(process.env.DOTBABEL_MODELS_DEV_INTEGRATION !== "1");

runnable("models-dev adapter against the live document", () => {
  it("discovers the providers Dotbabel's runtimes use, within the OPS-2 entry limit", async () => {
    const providers = ["anthropic", "openai", "google", "github-copilot", "opencode"];
    const result = await modelsDev.discover({ providers });
    expect(result.status, JSON.stringify(result.diagnostic)).toBe("ok");
    expect(result.provenance.sourceVersion).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(result.evidence.missingProviders).toEqual([]);
    for (const provider of result.evidence.providers) {
      expect(provider.discovery.models.length, provider.id).toBeGreaterThan(0);
    }
    // At least one Anthropic model states an effort vocabulary, as the Phase 0 measurement found.
    const anthropic = result.evidence.providers.find((p) => p.id === "anthropic");
    expect(anthropic.discovery.models.some((m) => m.supportedReasoningLevels.length > 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.evidence))).toBeLessThanOrEqual(modelsDev.MAX_ENTRY_BYTES);
    console.info(`[model-intelligence] models-dev ${result.provenance.sourceVersion}: ${result.evidence.providers.map((p) => `${p.id}=${p.discovery.models.length}`).join(" ")}`);
  }, 30_000);
});
