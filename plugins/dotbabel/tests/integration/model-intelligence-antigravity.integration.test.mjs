// Tier 2 (TEST-4): claims about an INSTALLED Antigravity CLI (`agy`) that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported.
//
// The adapter runs agy in a scratch home with no credential, so the real `discover()` meets the
// sign-in refusal that 1.4.2 returns; a network/auth-dependent listing is out of reach by design.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as antigravity from "../../src/model-intelligence/sources/runtime/antigravity.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const scratchEnv = home => ({ PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "" });
const probeHome = makeTempDir("mi-agy-version-");
const probe = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 30_000, env: scratchEnv(probeHome), cwd: probeHome });
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(`${probe.stdout}\n${probe.stderr}`) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";

const runnable = describe.skipIf(!integration || !installed);

runnable(`antigravity adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] agy ${version}`);
  });

  it("an isolated real discover() is unavailable, never an empty catalog", async () => {
    const result = await antigravity.discover({ env: { PATH: process.env.PATH }, homeDir: makeTempDir("mi-agy-real-home-"), timeoutMs: 120_000 });
    expect(result.status).toBe("unavailable");
    expect(["sign_in_required", "nonzero_exit"]).toContain(result.diagnostic.code);
  }, 150_000);

  it("exposes --model and --effort with the five measured values, as the descriptor claims", () => {
    const home = makeTempDir("mi-agy-help-");
    const help = spawnSync("agy", ["--help"], { encoding: "utf8", timeout: 30_000, env: scratchEnv(home), cwd: home });
    const text = `${help.stdout}${help.stderr}`;
    expect(text).toMatch(/--model\s+Model for the current CLI session/);
    expect(text).toMatch(/--effort\s+Reasoning effort for the current CLI session \(low\|medium\|high\|xhigh\|max\)/);
  });

  it("discover() never writes under the real configuration root (SEC-1)", async () => {
    const home = makeTempDir("mi-agy-sec1-"); const realRoot = join(home, ".gemini");
    mkdirSync(realRoot, { recursive: true }); writeFileSync(join(realRoot, "settings.json"), "{}");
    const before = snapshotTree(realRoot);
    await antigravity.discover({ env: { PATH: process.env.PATH, GEMINI_HOME: realRoot }, homeDir: home, timeoutMs: 120_000 });
    expect(snapshotTree(realRoot)).toEqual(before);
  }, 150_000);
});
