// Phase 2 PR 3 — argv contract test for push's §5.5.2 mandatory-`--from` rule.
//
// Pins the §5.5.2 minimum surface as a vitest contract:
//   - `push` without <query> and without --from exits 64
//   - `push --from <cli>` without <query> is accepted (exits non-64)
//   - `push <query>` without --from is accepted (explicit query exempts the rule)
//   - unknown flag exits 64 (§5.3.1)
//
// Hermetic env: DOTCLAUDE_HANDOFF_REPO pointing at a non-existent path.
// The argv rejection (exit 64) happens before any transport touch; positive
// cases exit non-64 on a transport/session-lookup error, which is a different
// path from argv rejection.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const HANDOFF_BIN = resolve(repoRoot, "plugins/dotclaude/bin/dotclaude-handoff.mjs");

function runHandoff(args, hermeticHome) {
  const result = spawnSync(process.execPath, [HANDOFF_BIN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: hermeticHome,
      XDG_CONFIG_HOME: hermeticHome,
      DOTCLAUDE_HANDOFF_REPO: "/nonexistent/handoff-push-from-contract",
      DOTCLAUDE_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("handoff push — §5.5.2 mandatory-`--from` contract (Phase 2 PR 3)", () => {
  /** @type {string} */
  let hermeticHome;

  beforeAll(() => {
    hermeticHome = mkdtempSync(resolve(tmpdir(), "handoff-push-from-contract-"));
  });

  afterAll(() => {
    rmSync(hermeticHome, { recursive: true, force: true });
  });

  it("push without <query> and without --from exits 64 (§5.5.2)", () => {
    const result = runHandoff(["push"], hermeticHome);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/requires --from/i);
  });

  it("push --from claude without <query> is accepted (parser does not reject)", () => {
    // No real session under hermeticHome, so exits non-zero (session-lookup
    // error), but NOT 64 — argv and mandatory-from checks both passed.
    const result = runHandoff(["push", "--from", "claude"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/requires --from/i);
  });

  it("push --from gemini without <query> is accepted (parser does not reject)", () => {
    const result = runHandoff(["push", "--from", "gemini"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/requires --from/i);
  });

  it("push <query> without --from is accepted (explicit query exempts the rule)", () => {
    const result = runHandoff(["push", "deadbeef"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/requires --from/i);
  });

  it("exits 64 on an unknown flag (§5.3.1)", () => {
    const result = runHandoff(["push", "--bogus"], hermeticHome);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unknown option/i);
  });
});
