// Unit tests for the scrubDigest helper that wraps handoff-scrub.sh.
// The sibling bats suite
// (plugins/dotbabel/tests/bats/handoff-scrub.bats) exercises the shell
// script itself; this file pins the Node-side contract: full-input scrubbed
// output, the `scrubbed:N` stderr-count parse, and the fail-closed behavior
// that pushRemote() relies on to avoid uploading unscrubbed content.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubDigest, SCRUB_ERROR_PREFIX } from "../src/lib/handoff-scrub.mjs";

/**
 * Build a temporary stub script that mimics handoff-scrub.sh's contract
 * (stdin→stdout, `scrubbed:N` on stderr, exit 0) or any corruption of it
 * the caller wants to simulate. Returns the absolute path.
 */
function stubScript(body) {
  const dir = mkdtempSync(join(tmpdir(), "scrub-stub-"));
  const path = join(dir, "handoff-scrub.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("scrubDigest", () => {
  it("returns the real scrubber's output with an accurate count for clean input", () => {
    // No stub — use the real script. Clean prose should emit count 0 and
    // round-trip unchanged.
    const text = "Plain prose with no tokens, numbers 1234 and /tmp/foo.";
    const result = scrubDigest(text);
    expect(result.count).toBe(0);
    expect(result.scrubbed).toBe(text);
  });

  it("redacts a seeded github token and reports count 1", () => {
    const text = "pre ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 post";
    const result = scrubDigest(text);
    expect(result.count).toBe(1);
    expect(result.scrubbed).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456");
    expect(result.scrubbed).toContain("<redacted:github-token>");
  });

  it("counts multi-match inputs faithfully", () => {
    const text = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456\nAKIAIOSFODNN7EXAMPLE\n";
    const result = scrubDigest(text);
    expect(result.count).toBe(2);
  });

  it("throws when the scrubber script is missing", () => {
    expect(() =>
      scrubDigest("any input", { scriptPath: "/nonexistent/handoff-scrub.sh" }),
    ).toThrow(SCRUB_ERROR_PREFIX);
  });

  it("throws when the scrubber exits non-zero (fail-closed contract)", () => {
    const { dir, path } = stubScript("exit 3");
    try {
      expect(() => scrubDigest("any input", { scriptPath: path })).toThrow(
        SCRUB_ERROR_PREFIX,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when stderr lacks the scrubbed:N line", () => {
    // Exits 0 and echoes stdin to stdout but never writes the count line.
    const { dir, path } = stubScript("cat");
    try {
      expect(() => scrubDigest("any input", { scriptPath: path })).toThrow(
        SCRUB_ERROR_PREFIX,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when stderr reports a non-numeric count", () => {
    const { dir, path } = stubScript(
      "cat\nprintf 'scrubbed:abc\\n' >&2",
    );
    try {
      expect(() => scrubDigest("any input", { scriptPath: path })).toThrow(
        SCRUB_ERROR_PREFIX,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
