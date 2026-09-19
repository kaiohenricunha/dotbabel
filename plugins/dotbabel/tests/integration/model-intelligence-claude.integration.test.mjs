// Tier 2 (TEST-4): claims about an INSTALLED Claude Code that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported, because
// Claude Code changed its model validation between 2.1.274 and 2.1.278 and a result means nothing
// without the version it came from.
//
// Nothing here runs a model turn. The one case that needs a turn is gated behind Tier 3
// (DOTBABEL_MODELS_TIER3=1), and it runs the turn in the test itself, because the adapter never does.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as claude from "../../src/model-intelligence/sources/runtime/claude.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 20_000 });
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(probe.stdout) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";
const tier3 = process.env.DOTBABEL_MODELS_TIER3 === "1";

const runnable = describe.skipIf(!integration || !installed);
const turnRunnable = describe.skipIf(!integration || !installed || !tier3);

runnable(`claude adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    // TEST-4: an integration result is only meaningful with the version it came from.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] claude ${version}`);
  });

  it("recognises the stable aliases and a valid effort without running a model turn", async () => {
    const result = await claude.validate({ model: "opus", effort: "high" });
    expect(result.status).toBe("ok");
    // Recognised means the runtime got past model and effort handling and stopped at
    // authentication, which the credential-free scratch home guarantees: nothing was billed.
    const [model, effort] = result.evidence.checks;
    expect(model).toMatchObject({ axis: "model", value: "opus", verdict: "recognized" });
    expect(effort).toMatchObject({ axis: "reasoning", value: "high", verdict: "recognized" });
    expect(result.provenance.sourceVersion).toBe(version);
  });

  it("classifies an unknown model and an unknown effort with the runtime's own text", async () => {
    const result = await claude.validate({ model: "dotbabel-nonexistent-model", effort: "dotbabel-bogus" });
    const [model, effort] = result.evidence.checks;
    // The catalog miss is version dependent (2.1.274 refused the model, 2.1.278 warns), so only the
    // verdict is asserted, and the runtime's own text is required to be present.
    expect(model.verdict).toBe("unrecognized");
    expect(model.runtimeText).toEqual(expect.any(String));
    expect(effort.verdict).toBe("unrecognized");
    // The valid set is only ever revealed in the runtime's warning (DOC-2, constraint 13).
    expect(effort.validValues).toEqual(expect.arrayContaining(["low", "high"]));
  });

  it("reads the resolved model from system/init with no credential and no turn", async () => {
    const result = await claude.observe({ model: "opus" });
    expect(result.status).toBe("ok");
    expect(result.evidence.model).toEqual(expect.any(String));
    expect(result.evidence.turnExecuted).toBe(false);
    expect(result.evidence.usage).toEqual([]);
    // Effort is not observable on Claude Code (DOC-2, constraint 19).
    expect(Object.hasOwn(result.evidence, "effort")).toBe(false);
  });

  it("classifies discovery as unsupported, because there is no enumeration command", async () => {
    const result = await claude.discover();
    expect(result.status).toBe("unsupported");
    expect(result.diagnostic.code).toBe("no_enumeration");
  });

  it("never writes under a real configuration root (SEC-1)", async () => {
    // A directory standing in for the user's config root. If the adapter ran Claude against it, the
    // runtime would write projects, backups and telemetry there, as it does everywhere it runs.
    const root = makeTempDir("mi-claude-realroot-");
    const before = snapshotTree(root);
    const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: root };
    await claude.observe({ env, model: "opus" });
    await claude.validate({ model: "opus", effort: "high" }, { env });
    expect(snapshotTree(root)).toEqual(before);
  });
});

turnRunnable(`claude observation that needs a model turn (Tier 3) against ${version ?? "(not installed)"}`, () => {
  it("parses result.modelUsage from a stream the test produced by running one real turn", async () => {
    // The adapter never runs a turn (SEC-1), so this test does, once, with the user's own credentials,
    // and hands the stream to the adapter as its `context.stream`.
    const run = spawnSync("claude", ["-p", "Reply with exactly: OK", "--output-format", "stream-json", "--verbose", "--no-session-persistence"], { encoding: "utf8", timeout: 120_000 });
    const result = await claude.observe({ stream: run.stdout });
    expect(result.status).toBe("ok");
    expect(result.evidence.turnExecuted).toBe(true);
    expect(result.evidence.usage.length).toBeGreaterThan(0);
  });
});
