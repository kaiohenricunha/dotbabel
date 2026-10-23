// Tier 2 (TEST-4): claims about an INSTALLED OpenCode that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported.
//
// The adapter runs OpenCode under a scratch home with no provider and no credential, so the real
// `discover()` must return the exit-0/empty-output case as unknown (ARCH-30).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as opencode from "../../src/model-intelligence/sources/runtime/opencode.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const probe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, HOME: makeTempDir("mi-opencode-version-") } });
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(probe.stdout) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";

const runnable = describe.skipIf(!integration || !installed);

runnable(`opencode adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] opencode ${version}`);
  });

  it("an isolated real discover() is the exit-0/empty-output case, reported as unknown (ARCH-30)", async () => {
    const home = makeTempDir("mi-opencode-real-home-");
    const result = await opencode.discover({ env: { PATH: process.env.PATH }, homeDir: home, timeoutMs: 120_000 });
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("empty_output");
  }, 150_000);

  it("run --help exposes --model in provider/model form and no effort flag, as the descriptor claims", () => {
    const home = makeTempDir("mi-opencode-help-");
    const help = spawnSync("opencode", ["run", "--help"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state") }, cwd: home });
    expect(`${help.stdout}${help.stderr}`).toMatch(/--model, -m\s+string\s+Model to use in the format provider\/model/);
    expect(`${help.stdout}${help.stderr}`).not.toMatch(/--(effort|reasoning-effort)\b/);
  });

  it("discover() never writes under the real configuration root (SEC-1)", async () => {
    const home = makeTempDir("mi-opencode-sec1-"); const realRoot = join(home, ".config", "opencode");
    mkdirSync(realRoot, { recursive: true }); writeFileSync(join(realRoot, "opencode.json"), "{}");
    const before = snapshotTree(realRoot);
    await opencode.discover({ env: { PATH: process.env.PATH, OPENCODE_CONFIG_DIR: realRoot }, homeDir: home, timeoutMs: 120_000 });
    expect(snapshotTree(realRoot)).toEqual(before);
  }, 150_000);
});
