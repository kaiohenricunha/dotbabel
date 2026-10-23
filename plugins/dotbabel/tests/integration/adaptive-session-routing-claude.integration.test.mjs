import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Tier 3 runs one ordinary native MAIN turn through the production launcher on the caller's account.
// Without an explicit opt-in this is skipped, never simulated or reported as passing.
it.skipIf(process.env.DOTBABEL_MODELS_TIER3 !== "1")("proves the routed model from native usage in a real Claude main-session turn, and never reports effort applied without evidence", async () => {
  const script = fileURLToPath(new URL("../../../../experiments/adaptive-session-routing-claude/verify-native.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--live"], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  const summary = JSON.parse(stdout.trim().split("\n").at(-1));
  expect(summary).toMatchObject({ mode: "native-main-ordinary-prompt-attempt", code: 0 });
  expect(summary.numTurns).toBeGreaterThan(0);
  const proof = JSON.parse(await readFile(summary.file, "utf8"));
  const routing = proof.observations.filter(event => event.subtype === "ui_log").map(event => { try { return JSON.parse(event.text); } catch { return undefined; } }).filter(value => value?.envelope === "ClaudeRouting");
  const intended = routing.find(value => value.intended?.model)?.intended;
  expect(intended?.model).toEqual(expect.any(String));
  // The model is proven only by returned native usage.
  expect(Object.keys(proof.result.modelUsage)).toContain(intended.model);
  expect(routing.some(value => value.effective?.state === "observed" && value.effective.axes?.model === intended.model && value.effective.source === "turn.step:usage.model")).toBe(true);
  // Effort: reported only with correlated Stop evidence, and then it is the effort the request carried.
  for (const value of routing.filter(item => item.effective?.axes?.reasoning !== undefined)) {
    expect(value.effective.reasoningSource).toBe("classic.Stop:effort.level");
    expect(value.effective.axes.reasoning).toBe(intended.reasoning);
  }
}, 330000);
