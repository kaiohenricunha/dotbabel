#!/usr/bin/env node
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { validateSpecs } from "../src/validate-specs.mjs";

const args = process.argv.slice(2);
const rrIdx = args.indexOf("--repo-root");
const repoRoot = rrIdx >= 0 ? args[rrIdx + 1] : undefined;

const ctx = createHarnessContext({ repoRoot });

const result = validateSpecs(ctx);
if (result.ok) {
  const { listSpecDirs } = await import("../src/spec-harness-lib.mjs");
  const count = listSpecDirs(ctx).length;
  console.log(`✅ ${count} spec(s) valid.`);
  process.exit(0);
}
console.error("❌ Spec validation failed:");
for (const err of result.errors) console.error(`  - ${err}`);
process.exit(1);
