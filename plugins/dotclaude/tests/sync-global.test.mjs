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
});
