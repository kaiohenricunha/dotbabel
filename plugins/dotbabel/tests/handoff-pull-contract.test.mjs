// Phase 2 PR 1 — argv contract test for the `pull` verb.
//
// Pins the §5.2.1 minimum surface as a vitest contract:
//   - <query> positional accepted
//   - --from <cli> accepted
//   - --limit <N> accepted
//   - unknown flag exits 64 (§4.1 step 1, §5.3.1)
//
// Companion to plugins/dotbabel/tests/bats/handoff-pull-local-emit.bats which
// covers the §4.1 data-flow path. This file scopes to argv-shape only and
// spawns the bin to exercise it end-to-end through the parser.
//
// Deliberately NOT pinned (out-of-spec per §5.2.1; removed in later PRs):
//   --to (PR 4), --summary / -o (PR 5).
// We allow the bin to accept those without asserting either way.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { makeClaudeSession } from "./fixtures/handoff-sessions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const HANDOFF_BIN = resolve(repoRoot, "plugins/dotbabel/bin/dotbabel-handoff.mjs");

const CLAUDE_UUID = "aaaa1111-3333-3333-3333-333333333333";
const CLAUDE_SHORT = CLAUDE_UUID.slice(0, 8);

/**
 * Run the handoff bin with the given args and a hermetic env. Returns
 * `{ status, stdout, stderr }` regardless of exit code (does not throw).
 *
 * Hermetic env covers HOME + XDG_CONFIG_HOME so persisted handoff.env
 * cannot leak in, plus DOTBABEL_HANDOFF_REPO set to a non-existent path
 * so any inadvertent remote call surfaces as a non-zero exit.
 */
function runHandoff(args, hermeticHome) {
  try {
    const stdout = execFileSync(process.execPath, [HANDOFF_BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: hermeticHome,
        XDG_CONFIG_HOME: hermeticHome,
        DOTBABEL_HANDOFF_REPO: "/nonexistent/handoff-pull-contract",
        DOTBABEL_QUIET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
    };
  }
}

describe("handoff pull — §5.2.1 argv contract (Phase 2 PR 1)", () => {
  /** @type {string} */
  let hermeticHome;

  beforeAll(() => {
    hermeticHome = mkdtempSync(resolve(tmpdir(), "handoff-pull-contract-"));
    makeClaudeSession(hermeticHome, { uuid: CLAUDE_UUID });
  });

  afterAll(() => {
    rmSync(hermeticHome, { recursive: true, force: true });
  });

  it("accepts <query> positional and renders the <handoff> block", () => {
    const result = runHandoff(["pull", CLAUDE_SHORT], hermeticHome);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("<handoff ");
    expect(result.stdout).toContain("</handoff>");
    expect(result.stdout).toContain('origin="claude"');
    expect(result.stdout).toContain(`session="${CLAUDE_SHORT}"`);
  });

  it("accepts --from <cli>", () => {
    const result = runHandoff(["pull", CLAUDE_SHORT, "--from", "claude"], hermeticHome);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('origin="claude"');
  });

  it("accepts --limit <N>", () => {
    // Just assert the parser accepts the flag and the bin completes
    // successfully. We do NOT assert the exact turn count — that's a
    // §4.1 data-flow detail covered by the bats integration test, and
    // per-extractor turn semantics aren't part of the §5.2.1 argv contract.
    const result = runHandoff(["pull", CLAUDE_SHORT, "--limit", "5"], hermeticHome);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("<handoff ");
  });

  it("exits 64 on an unknown flag (§4.1 step 1, §5.3.1)", () => {
    const result = runHandoff(["pull", CLAUDE_SHORT, "--bogus"], hermeticHome);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unknown option/i);
  });
});
