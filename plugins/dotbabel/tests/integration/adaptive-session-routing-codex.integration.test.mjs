import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Tier 3 starts two primary native model turns using the caller's native account.
// Without an explicit opt-in this is skipped, never simulated or reported as passing.
it.skipIf(process.env.DOTBABEL_MODELS_TIER3 !== "1")("observes two effective configurations in one real Codex thread", async () => {
  const script = fileURLToPath(new URL("../../../../experiments/adaptive-session-routing-codex/real-turn.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--live"], { timeout: 210000, maxBuffer: 2 * 1024 * 1024 });
  const proof = JSON.parse(stdout);
  expect(proof.threadId).toEqual(expect.any(String));
  expect(proof.turns).toHaveLength(2);
  expect(proof.configurationsDiffer).toBe(true);
  expect(proof.exactOriginalMessages).toBe(true);
  expect(proof.observedUserMessages).toHaveLength(2);
  expect(new Set(proof.turns.map(turn => turn.turnId)).size).toBe(2);
  for (const turn of proof.turns) {
    expect(turn).toMatchObject({ status: "completed", decision: "proposed", effectiveAtAcknowledgement: "unknown", inputUnchanged: true, observationSource: "thread/read after turn/completed" });
    expect(turn.nativeObserved).toEqual(turn.selected);
    expect(proof.observedUserMessages.find(message => message.turnId === turn.turnId).textSha256).toEqual([turn.promptSha256]);
  }
  expect(proof.reroutes).toEqual([]);
  expect(proof.transportDiagnostics).toEqual([]);
  expect(proof.extraClassifierInferenceCalls).toBe(0);
  expect(proof.transcriptReplayed).toBe(false);
}, 240000);
