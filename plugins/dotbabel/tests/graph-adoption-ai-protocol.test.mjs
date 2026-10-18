import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("the AI protocol validates complete synthetic source archives and remains offline", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // This includes pinned comparisons through real fixture subprocesses and full hash reconstruction.
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "docs/experiments/graph-step-adoption-v2/protocol.test.mjs"],
  { cwd: root, encoding: "utf8", timeout: 120000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/# fail 0/);
}, 125000);
