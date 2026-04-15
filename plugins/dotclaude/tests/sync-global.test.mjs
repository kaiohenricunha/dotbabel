/**
 * Tests for sync-global.mjs
 *
 * Uses vitest with vi.mock / vi.spyOn to intercept spawnSync and bootstrapGlobal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process spawnSync before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

// Mock bootstrapGlobal so tests don't touch the real filesystem
vi.mock("../src/bootstrap-global.mjs", () => ({
  bootstrapGlobal: vi.fn().mockResolvedValue({ ok: true, linked: 3, skipped: 0, backed_up: 0 }),
}));

// Mock index.mjs version export
vi.mock("../src/index.mjs", () => ({
  version: "1.2.3",
}));

import { spawnSync } from "node:child_process";
import { bootstrapGlobal } from "../src/bootstrap-global.mjs";
import { resolveMode, syncGlobal } from "../src/sync-global.mjs";

// ---------------------------------------------------------------------------
// Test 1 & 2 — resolveMode
// ---------------------------------------------------------------------------

describe("resolveMode", () => {
  it("returns 'clone' when source option is provided", () => {
    expect(resolveMode("/home/user/dotclaude")).toBe("clone");
  });

  it("returns 'npm' when no source is provided", () => {
    expect(resolveMode(undefined)).toBe("npm");
    expect(resolveMode(null)).toBe("npm");
    expect(resolveMode("")).toBe("npm");
  });
});

// ---------------------------------------------------------------------------
// Tests 3–8 — syncGlobal
// ---------------------------------------------------------------------------

describe("syncGlobal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 3 — pull (npm mode) calls npm update when newer version is available
  // -------------------------------------------------------------------------

  it("pull (npm mode) calls npm update when newer version is available", async () => {
    // npm view returns a newer version
    spawnSync
      .mockReturnValueOnce({ stdout: "1.3.0\n", stderr: "", status: 0 })   // npm view
      .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });           // npm update

    const result = await syncGlobal("pull", {});

    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["view", "@dotclaude/dotclaude", "version"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["update", "-g", "@dotclaude/dotclaude"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(bootstrapGlobal).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("npm");
  });

  // -------------------------------------------------------------------------
  // Test 4 — pull (npm mode) skips update when already at latest version
  // -------------------------------------------------------------------------

  it("pull (npm mode) skips update when already at latest version", async () => {
    // npm view returns the same version as current (1.2.3)
    spawnSync.mockReturnValueOnce({ stdout: "1.2.3\n", stderr: "", status: 0 });

    const result = await syncGlobal("pull", {});

    // npm update should NOT have been called
    const updateCalls = spawnSync.mock.calls.filter(
      (call) => call[0] === "npm" && call[1].includes("update")
    );
    expect(updateCalls).toHaveLength(0);
    // bootstrapGlobal still called (re-link)
    expect(bootstrapGlobal).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("npm");
  });

  // -------------------------------------------------------------------------
  // Test 5 — pull (clone mode) runs git fetch, rebase then bootstraps
  // -------------------------------------------------------------------------

  it("pull (clone mode) runs git fetch, rebase then bootstraps", async () => {
    spawnSync
      .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 })  // git fetch
      .mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });  // git rebase

    const source = "/home/user/dotclaude";
    const result = await syncGlobal("pull", { source });

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["-C", source, "fetch", "origin"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["-C", source, "rebase", "origin/main"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(bootstrapGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ source })
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("clone");
  });

  // -------------------------------------------------------------------------
  // Test 6 — status (npm mode) reports current and latest version
  // -------------------------------------------------------------------------

  it("status (npm mode) reports current and latest version", async () => {
    spawnSync.mockReturnValueOnce({ stdout: "1.5.0\n", stderr: "", status: 0 });

    const result = await syncGlobal("status", {});

    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["view", "@dotclaude/dotclaude", "version"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("npm");
    // summary should mention both installed and latest
    expect(result.summary).toMatch(/1\.2\.3/);
    expect(result.summary).toMatch(/1\.5\.0/);
  });

  // -------------------------------------------------------------------------
  // Test 7 — status (clone mode) delegates to git status
  // -------------------------------------------------------------------------

  it("status (clone mode) delegates to git status", async () => {
    const gitStatusOutput = " M CLAUDE.md\n";
    spawnSync.mockReturnValueOnce({ stdout: gitStatusOutput, stderr: "", status: 0 });

    const source = "/home/user/dotclaude";
    const result = await syncGlobal("status", { source });

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["-C", source, "status", "--short"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("clone");
  });

  // -------------------------------------------------------------------------
  // Test 8 — push (npm mode) exits with a failure message
  // -------------------------------------------------------------------------

  it("push (npm mode) exits with a failure message", async () => {
    const result = await syncGlobal("push", {});

    // No git/npm calls expected
    expect(spawnSync).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("npm");
    expect(result.summary).toMatch(/clone mode/i);
  });

  // -------------------------------------------------------------------------
  // Test 9 — push (clone mode) happy path
  // -------------------------------------------------------------------------

  it("push (clone mode) commits and pushes when no secrets detected", async () => {
    const source = "/home/user/dotclaude";
    // git add -A
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });
    // git diff --cached --quiet → non-zero means there ARE staged changes
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 1 });
    // git diff --cached --name-only → returns staged filenames
    spawnSync.mockReturnValueOnce({ stdout: "CLAUDE.md\n", stderr: "", status: 0 });
    // git show :CLAUDE.md → clean content (no secrets)
    spawnSync.mockReturnValueOnce({ stdout: "# CLAUDE\n", stderr: "", status: 0 });
    // git commit
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });
    // git push
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });

    const result = await syncGlobal("push", { source });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("clone");
  });

  // -------------------------------------------------------------------------
  // Test 10 — push (clone mode) aborts when secret detected
  // -------------------------------------------------------------------------

  it("push (clone mode) aborts when a secret is detected in staged files", async () => {
    const source = "/home/user/dotclaude";
    // git add -A
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });
    // git diff --cached --quiet → non-zero means staged changes exist
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 1 });
    // git diff --cached --name-only
    spawnSync.mockReturnValueOnce({ stdout: "config.js\n", stderr: "", status: 0 });
    // git show :config.js → contains a secret-shaped value
    spawnSync.mockReturnValueOnce({
      stdout: "const API_KEY = 'AKIAIOSFODNN7EXAMPLE123456789012';\n",
      stderr: "",
      status: 0,
    });

    const result = await syncGlobal("push", { source });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("clone");
    // commit and push must NOT have been called
    const calls = spawnSync.mock.calls.map((c) => c.slice(0, 2));
    expect(calls).not.toContainEqual(["git", ["-C", source, "commit", expect.any(String), expect.any(String)]]);
  });

  // -------------------------------------------------------------------------
  // Test 11 — pull (npm mode) fails when npm view returns non-zero
  // -------------------------------------------------------------------------

  it("pull (npm mode) returns ok:false when npm view fails", async () => {
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "network error", status: 1 });

    const result = await syncGlobal("pull", {});

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("npm");
    expect(result.summary).toMatch(/npm view failed/i);
    // npm update must NOT have been called
    const updateCalls = spawnSync.mock.calls.filter(
      (call) => call[0] === "npm" && call[1].includes("update")
    );
    expect(updateCalls).toHaveLength(0);
    expect(bootstrapGlobal).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 12 — push (clone mode) aborts when git show fails during secret scan
  // -------------------------------------------------------------------------

  it("push (clone mode) aborts when git show fails during secret scan", async () => {
    const source = "/home/user/dotclaude";
    // git add -A
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 0 });
    // git diff --cached --quiet → staged changes
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "", status: 1 });
    // git diff --cached --name-only
    spawnSync.mockReturnValueOnce({ stdout: "broken.md\n", stderr: "", status: 0 });
    // git show :broken.md → fails
    spawnSync.mockReturnValueOnce({ stdout: "", stderr: "fatal: path not found", status: 128 });

    const result = await syncGlobal("push", { source });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("clone");
    expect(result.summary).toMatch(/could not read staged file/i);
  });
});
