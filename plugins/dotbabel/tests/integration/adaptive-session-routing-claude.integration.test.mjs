import { it, expect } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { VERIFIED_MAIN_VERSIONS } from "../../src/model-intelligence/sources/runtime/claude.mjs";

// Tier 3 runs one ordinary native MAIN turn through the production launcher on the caller's account.
// Without an explicit opt-in this is skipped, never simulated or reported as passing.
it.skipIf(process.env.DOTBABEL_MODELS_TIER3 !== "1")("proves the routed model from native usage in a real Claude main-session turn, and never reports effort applied without evidence", async () => {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  expect(VERIFIED_MAIN_VERSIONS, `Claude ${version} is not an accepted release`).toContain(version);
  const script = fileURLToPath(new URL("../../../../experiments/adaptive-session-routing-claude/verify-native.mjs", import.meta.url));
  const out = join(await mkdtemp(join(tmpdir(), "dotbabel-ac11-")), "proof.json");
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--live", "--out", out], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  const summary = JSON.parse(stdout.trim().split("\n").at(-1));
  expect(summary).toMatchObject({ mode: "native-main-ordinary-prompt-attempt", code: 0, file: out });
  const proof = JSON.parse(await readFile(out, "utf8"));
  expect(proof.result, "the native run produced no result event").toBeTruthy();
  expect(proof.result.num_turns).toBeGreaterThan(0);
  const routing = proof.observations.filter(event => event.subtype === "ui_log").map(event => { try { return JSON.parse(event.text); } catch { return undefined; } }).filter(value => value?.envelope === "ClaudeRouting");
  // A routed turn: the shared resolver proposed a configuration for this MAIN turn.
  const proposal = routing.find(value => value.status === "proposed" && value.intended?.model);
  expect(proposal?.diagnostics?.map(item => item.code)).toContain("configuration_proposed");
  const { intended } = proposal;
  // The model is proven only by returned native usage.
  expect(Object.keys(proof.result.modelUsage ?? {})).toContain(intended.model);
  expect(routing.some(value => value.effective?.state === "observed" && value.effective.axes?.model === intended.model && value.effective.source === "turn.step:usage.model")).toBe(true);
  // Effort: reported only with correlated Stop evidence, and then it is the effort the request carried.
  // The unit suite covers both Stop branches; this run cannot see the session level Stop received.
  for (const value of routing.filter(item => item.effective?.axes?.reasoning !== undefined)) {
    expect(value.effective.reasoningSource).toBe("classic.Stop:effort.level");
    expect(value.effective.axes.reasoning).toBe(intended.reasoning);
  }
}, 330000);
