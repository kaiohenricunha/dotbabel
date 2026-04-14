#!/usr/bin/env node
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkInstructionDrift } from "../src/check-instruction-drift.mjs";

const args = process.argv.slice(2);
const rrIdx = args.indexOf("--repo-root");
const repoRoot = rrIdx >= 0 ? args[rrIdx + 1] : undefined;

const ctx = createHarnessContext({ repoRoot });

const result = checkInstructionDrift(ctx);
if (result.ok) {
  console.log("✅ Instruction files match repo facts.");
  process.exit(0);
}
console.error("❌ Instruction drift detected:");
for (const err of result.errors) console.error(`  - ${err}`);
process.exit(1);
