// Tier 2 (TEST-4): claims about an INSTALLED Codex that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported: the
// model catalog held 9 models on 0.155.1 and 11 on 0.154.0, so a result is meaningless without it.
//
// Everything runs offline and with no credential, because that is how the adapter runs Codex.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as codex from "../../src/model-intelligence/sources/runtime/codex.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const probe = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 20_000 });
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(probe.stdout) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";

const runnable = describe.skipIf(!integration || !installed);

runnable(`codex adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] codex ${version}`);
  });

  it("parses codex debug models, offline, into per-model supported reasoning levels", async () => {
    // The adapter points every proxy at a dead port, so a result at all proves the catalog is bundled.
    const result = await codex.discover();
    expect(result.status).toBe("ok");
    expect(result.evidence.models.length).toBeGreaterThan(0);
    for (const model of result.evidence.models) {
      expect(model.id, "model id").toEqual(expect.any(String));
      expect(Array.isArray(model.supportedReasoningLevels)).toBe(true);
      // The catalog carries no provider, so none is ever invented (DOC-2, constraint 6).
      expect(Object.hasOwn(model, "provider")).toBe(false);
    }
    expect(result.provenance.sourceVersion).toBe(version);
  });

  it("reports which models accept each effort, so a requirement for one can be refused", async () => {
    const { effortSupport, models } = (await codex.discover()).evidence;
    expect(Object.keys(effortSupport).length).toBeGreaterThan(0);
    for (const [effort, support] of Object.entries(effortSupport)) {
      // Every model is on exactly one side of every effort.
      expect(support.supportedBy.length + support.notSupportedBy.length, effort).toBe(models.length);
    }
  });

  it("reads the resolved model, provider and effort from the exec banner without credentials or network", async () => {
    const result = await codex.observe();
    expect(result.status).toBe("ok");
    const observed = result.evidence;
    expect(observed.model).toEqual(expect.any(String));
    expect(observed.turnExecuted).toBe(false);
    // The provider comes from its own banner line and is never the model.
    if (observed.provider !== undefined) expect(observed.provider).not.toBe(observed.model);
    expect(result.provenance.sourceVersion).toBe(version);
  });

  it("recognises the model and reasoning configuration keys under --strict-config", async () => {
    const result = await codex.validate({ model: "gpt-5.5", reasoning: "high" });
    expect(result.status).toBe("ok");
    for (const check of result.evidence.checks) {
      expect(check.scope).toBe("key");
      expect(check.verdict).toBe("recognized");
    }
  });

  it("never writes under a real configuration root (SEC-1)", async () => {
    // A directory standing in for the user's CODEX_HOME. `codex exec` wrote 4.2 MB into whatever it
    // was given, so a clean tree afterwards proves the adapter ran it somewhere else.
    const root = makeTempDir("mi-codex-realroot-");
    writeFileSync(join(root, "config.toml"), 'model = "gpt-5.5"\n');
    writeFileSync(join(root, "auth.json"), "{}");
    const before = snapshotTree(root);
    const env = { PATH: process.env.PATH, CODEX_HOME: root };
    await codex.discover({ env });
    await codex.observe({ env });
    await codex.validate({ model: "gpt-5.5" }, { env });
    expect(snapshotTree(root)).toEqual(before);
  });
});
