import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("the locked adoption protocol and its real CLI contracts pass offline", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "docs/experiments/graph-step-adoption/protocol.test.mjs",
    "docs/experiments/graph-step-adoption/run.test.mjs"],
  { cwd: root, encoding: "utf8", timeout: 25000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/# fail 0/);
});
