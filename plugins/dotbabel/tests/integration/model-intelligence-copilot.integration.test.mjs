// Tier 2 (TEST-4): claims about an INSTALLED GitHub Copilot CLI that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported.
//
// The adapter runs Copilot in a scratch home with no credential. `help config` needs no sign-in,
// so the real `discover()` reads the documented model values; that list is help text, not entitlement.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as copilot from "../../src/model-intelligence/sources/runtime/copilot.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const scratchEnv = home => ({ PATH: process.env.PATH, HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "" });
const probeHome = makeTempDir("mi-copilot-version-");
const probe = spawnSync("copilot", ["--version"], { encoding: "utf8", timeout: 30_000, env: scratchEnv(probeHome), cwd: probeHome });
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(probe.stdout) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";

const runnable = describe.skipIf(!integration || !installed);

runnable(`copilot adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] copilot ${version}`);
  });

  it("an isolated real discover() reads the documented model values without a credential", async () => {
    const result = await copilot.discover({ env: { PATH: process.env.PATH }, homeDir: makeTempDir("mi-copilot-real-home-"), timeoutMs: 120_000 });
    expect(result.status).toBe("ok");
    expect(result.evidence.models.length).toBeGreaterThan(0);
    expect(result.provenance.sourceVersion).toBe(version);
  }, 150_000);

  it("exposes --model and --reasoning-effort, as the descriptor claims", () => {
    const home = makeTempDir("mi-copilot-help-");
    const help = spawnSync("copilot", ["--help"], { encoding: "utf8", timeout: 30_000, env: scratchEnv(home), cwd: home });
    const text = `${help.stdout}${help.stderr}`;
    expect(text).toMatch(/--model <model>/);
    expect(text).toMatch(/--reasoning-effort <level>/);
  });

  it("discover() never writes under the real configuration root (SEC-1)", async () => {
    const home = makeTempDir("mi-copilot-sec1-"); const realRoot = join(home, ".copilot");
    mkdirSync(realRoot, { recursive: true }); writeFileSync(join(realRoot, "config.json"), "{}");
    const before = snapshotTree(realRoot);
    await copilot.discover({ env: { PATH: process.env.PATH, COPILOT_HOME: realRoot }, homeDir: home, timeoutMs: 120_000 });
    expect(snapshotTree(realRoot)).toEqual(before);
  }, 150_000);
});
