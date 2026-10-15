/**
 * Runs the vendored upstream validator suites (node:test, *.test.cjs) from
 * skills/security-audit/references/upstream/. Vitest only collects *.test.mjs,
 * so without this wrapper an upstream sync that breaks its own validators
 * would pass CI.
 */

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const UPSTREAM_DIR = join(REPO_ROOT, "skills", "security-audit", "references", "upstream");

describe("security-audit upstream validator suites", () => {
  it("pass under node --test", () => {
    const suites = readdirSync(UPSTREAM_DIR).filter((name) => name.endsWith(".test.cjs"));
    expect(suites.length).toBeGreaterThan(0);

    // Pin the reporter: from Node 24 `node --test` prints the spec format even
    // when stdout is not a TTY, so the TAP summary line asserted below exists
    // only when TAP is asked for. The release job runs on Node 24 (v4.0.0's
    // publish failed here); the PR matrix runs 20 and 22.
    const args = [
      "--test",
      "--test-reporter=tap",
      ...suites.map((name) => join(UPSTREAM_DIR, name)),
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: UPSTREAM_DIR,
      encoding: "utf8",
    });
    expect(result.status, result.stdout.slice(-2000) + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^# fail 0$/m);
  }, 120000);
});
