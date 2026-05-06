// Phase 2 PR 2 — argv contract test for the `fetch` verb.
//
// Pins the §5.2.3 minimum surface as a vitest contract:
//   - <query> positional accepted
//   - --from <cli> accepted
//   - --limit <N> accepted
//   - --summary exits 64 because it is pull-only
//   - unknown flag exits 64 (§4.3 step 1, §5.3.1)
//
// Companion to plugins/dotclaude/tests/bats/handoff-fetch-remote-download.bats
// which covers the §4.3 data-flow path (push then fetch, transport required,
// --from filtering). This file scopes to argv-shape only and does NOT need a
// real transport repo — argv parsing happens before the transport check, so
// negative cases that exit 64 work even with DOTCLAUDE_HANDOFF_REPO pointing
// at a non-existent path (as runHandoff() sets it to /nonexistent/...).
//
// Deliberately NOT pinned (extra-spec but tolerated):
//   --verify (currently accepted; not in §5.2.3).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const HANDOFF_BIN = resolve(repoRoot, "plugins/dotclaude/bin/dotclaude-handoff.mjs");

/**
 * Run the handoff bin with the given args under a hermetic env. Returns
 * `{ status, stdout, stderr }` regardless of exit code (does not throw).
 *
 * Hermetic env: HOME + XDG_CONFIG_HOME point at a fresh temp dir so persisted
 * handoff.env cannot leak in. DOTCLAUDE_HANDOFF_REPO is deliberately set to a
 * non-existent path — for argv-rejection tests the parser exits before any
 * transport touch, and for argv-acceptance tests we use queries that never
 * resolve so exit-2-on-no-remote-match comes after argv parsing.
 */
function runHandoff(args, hermeticHome) {
  try {
    const stdout = execFileSync(process.execPath, [HANDOFF_BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: hermeticHome,
        XDG_CONFIG_HOME: hermeticHome,
        DOTCLAUDE_HANDOFF_REPO: "/nonexistent/handoff-fetch-contract",
        DOTCLAUDE_QUIET: "1",
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

describe("handoff fetch — §5.2.3 argv contract (Phase 2 PR 2)", () => {
  /** @type {string} */
  let hermeticHome;

  beforeAll(() => {
    hermeticHome = mkdtempSync(resolve(tmpdir(), "handoff-fetch-contract-"));
  });

  afterAll(() => {
    rmSync(hermeticHome, { recursive: true, force: true });
  });

  it("accepts <query> positional (parser does not reject before transport check)", () => {
    // The query won't resolve (no real transport), so we expect a non-64
    // exit that's NOT an argv error. The parser must accept the positional.
    const result = runHandoff(["fetch", "deadbeef"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/unknown option/i);
  });

  it("accepts --from <cli>", () => {
    const result = runHandoff(["fetch", "deadbeef", "--from", "claude"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/unknown option/i);
  });

  it("accepts --limit <N>", () => {
    const result = runHandoff(["fetch", "deadbeef", "--limit", "5"], hermeticHome);
    expect(result.status).not.toBe(64);
    expect(result.stderr).not.toMatch(/unknown option/i);
  });

  it("exits 64 on --summary because summaries are pull-only", () => {
    const result = runHandoff(["fetch", "deadbeef", "--summary"], hermeticHome);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--summary is only valid on `pull`/);
    expect(result.stderr).toMatch(/`fetch` retrieves the rendered handoff\.md/);
  });

  it("exits 64 on an unknown flag (§4.3 step 1, §5.3.1)", () => {
    const result = runHandoff(["fetch", "deadbeef", "--bogus"], hermeticHome);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unknown option/i);
  });
});
