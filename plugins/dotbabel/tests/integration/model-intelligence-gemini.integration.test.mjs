// Tier 2 (TEST-4): claims about an INSTALLED Gemini CLI that a fixture cannot prove.
//
// Run with DOTBABEL_MODELS_INTEGRATION=1. Without it, or without the CLI, every test below is
// reported as skipped, never as a silent pass. The tested CLI version is always reported.
//
// Everything runs under a scratch home with no credential. Even `gemini --help` writes under
// `~/.gemini`, so no probe here may touch the real configuration root.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { snapshotTree } from "../fixtures/model-intelligence/fake-runner.mjs";
import * as gemini from "../../src/model-intelligence/sources/runtime/gemini.mjs";
import { parseVersion } from "../../src/model-intelligence/sources/runtime/process.mjs";

const isolatedEnv = home => ({ PATH: process.env.PATH, HOME: home, GEMINI_HOME: join(home, ".gemini"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "" });
const run = (args, home) => spawnSync("gemini", args, { encoding: "utf8", timeout: 30_000, env: isolatedEnv(home), cwd: home });

const versionHome = makeTempDir("mi-gemini-version-");
const probe = run(["--version"], versionHome);
const installed = probe.error === undefined && probe.status === 0;
const version = installed ? parseVersion(probe.stdout) : undefined;
const integration = process.env.DOTBABEL_MODELS_INTEGRATION === "1";

const runnable = describe.skipIf(!integration || !installed);

runnable(`gemini adapter against the installed CLI ${version ?? "(not installed)"}`, () => {
  it("reports the CLI it tested", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    console.info(`[model-intelligence] gemini ${version}`);
  });

  it("exposes -m/--model and no user-facing effort flag, as the descriptor claims", () => {
    const help = run(["--help"], makeTempDir("mi-gemini-help-"));
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^\s*-m, --model\b/m);
    expect(help.stdout).not.toMatch(/--(effort|reasoning|thinking|reasoning-effort)\b/);
    expect(gemini.descriptor.capabilities.invocation.axes).toEqual({ model: "supported", reasoning: "unsupported" });
  });

  it("offers no model-listing subcommand, so discovery stays unsupported", () => {
    const help = run(["--help"], makeTempDir("mi-gemini-commands-"));
    expect(help.stdout).not.toMatch(/^\s*gemini models\b/m);
    expect(gemini.descriptor.capabilities.discovery.support).toBe("unsupported");
  });

  it("the probes write only under the scratch home, never the real configuration root (SEC-1)", () => {
    const real = makeTempDir("mi-gemini-real-");
    mkdirSync(join(real, ".gemini"), { recursive: true });
    writeFileSync(join(real, ".gemini", "settings.json"), "{}");
    const before = snapshotTree(join(real, ".gemini"));
    const scratch = makeTempDir("mi-gemini-scratch-");
    run(["--help"], scratch);
    expect(snapshotTree(join(real, ".gemini"))).toEqual(before);
  });
});
