// Unit tests for plugins/dotbabel/src/lib/handoff-preflight.mjs.
//
// Strategy: use a real hermetic tempdir for cache file I/O (the point of the
// module) and mock only `spawnSync` so we don't actually spawn the doctor
// shell script. Mocking spawnSync cascades through `runScript` in
// handoff-remote.mjs — which is what autoPreflight invokes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PreflightHandledError } from "../src/lib/handoff-errors.mjs";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));
import { spawnSync } from "node:child_process";

import {
  autoPreflight,
  CACHE_SCHEMA_VERSION,
  DOCTOR_CACHE_TTL_MS,
  DOCTOR_SH,
  currentCacheDir,
  currentCacheFile,
  isFresh,
  readCache,
  writeCacheAtomic,
} from "../src/lib/handoff-preflight.mjs";

const REPO = "git@github.com:me/handoff-store.git";

let tempRoot;
let origXdg;
let origHome;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "preflight-test-"));
  origXdg = process.env.XDG_CACHE_HOME;
  origHome = process.env.HOME;
  process.env.XDG_CACHE_HOME = tempRoot;
  delete process.env.HOME; // force tests to rely on XDG
  spawnSync.mockReset();
});

afterEach(() => {
  if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
  else delete process.env.XDG_CACHE_HOME;
  if (origHome !== undefined) process.env.HOME = origHome;
  rmSync(tempRoot, { recursive: true, force: true });
});

function mockDoctor(status, { stdout = "", stderr = "" } = {}) {
  spawnSync.mockReturnValueOnce({ status, stdout, stderr });
}

// ---- constants / path helpers -------------------------------------------

describe("constants and path helpers", () => {
  it("exposes CACHE_SCHEMA_VERSION = 1", () => {
    expect(CACHE_SCHEMA_VERSION).toBe(1);
  });

  it("exposes DOCTOR_CACHE_TTL_MS = 5 * 60 * 1000", () => {
    expect(DOCTOR_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("DOCTOR_SH points at the real shell script path", () => {
    expect(DOCTOR_SH).toMatch(/scripts\/handoff-doctor\.sh$/);
  });

  it("currentCacheDir honors XDG_CACHE_HOME", () => {
    expect(currentCacheDir()).toBe(join(tempRoot, "dotbabel"));
  });

  it("currentCacheDir falls back to $HOME/.cache when XDG is unset", () => {
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/tmp/fakehome";
    expect(currentCacheDir()).toBe("/tmp/fakehome/.cache/dotbabel");
  });

  it("currentCacheDir tolerates both env vars being unset", () => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.HOME;
    // The function should not throw; the resulting path is something
    // unusable but callers will get an fs error on write, not a crash here.
    expect(() => currentCacheDir()).not.toThrow();
  });

  it("currentCacheFile appends handoff-doctor.json", () => {
    expect(currentCacheFile()).toBe(join(tempRoot, "dotbabel", "handoff-doctor.json"));
  });
});

// ---- isFresh -------------------------------------------------------------

describe("isFresh", () => {
  const now = 1_700_000_000_000;
  const fresh = {
    version: 1,
    timestamp: new Date(now - 60_000).toISOString(),
    repo: REPO,
    status: "ok",
  };

  it("returns true for a fresh entry within TTL", () => {
    expect(isFresh(fresh, REPO, now)).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(isFresh(null, REPO, now)).toBe(false);
    expect(isFresh(undefined, REPO, now)).toBe(false);
  });

  it("returns false for non-object entry", () => {
    expect(isFresh("ok", REPO, now)).toBe(false);
    expect(isFresh(42, REPO, now)).toBe(false);
  });

  it("returns false when repo differs", () => {
    expect(isFresh(fresh, "git@other:me/x.git", now)).toBe(false);
  });

  it("returns false when status is not 'ok'", () => {
    expect(isFresh({ ...fresh, status: "fail" }, REPO, now)).toBe(false);
  });

  it("returns false when schema version mismatches", () => {
    expect(isFresh({ ...fresh, version: 99 }, REPO, now)).toBe(false);
  });

  it("returns false when timestamp is unparseable", () => {
    expect(isFresh({ ...fresh, timestamp: "not-a-date" }, REPO, now)).toBe(false);
  });

  it("returns false past TTL", () => {
    const stale = { ...fresh, timestamp: new Date(now - DOCTOR_CACHE_TTL_MS - 1).toISOString() };
    expect(isFresh(stale, REPO, now)).toBe(false);
  });

  it("returns true exactly at TTL boundary", () => {
    const boundary = { ...fresh, timestamp: new Date(now - DOCTOR_CACHE_TTL_MS).toISOString() };
    expect(isFresh(boundary, REPO, now)).toBe(true);
  });
});

// ---- readCache / writeCacheAtomic ---------------------------------------

describe("readCache and writeCacheAtomic", () => {
  it("readCache returns null when file does not exist", () => {
    expect(readCache()).toBeNull();
  });

  it("readCache returns null when file contents are not JSON", () => {
    writeCacheAtomic({ version: 1, timestamp: new Date().toISOString(), repo: REPO, status: "ok" });
    writeFileSync(currentCacheFile(), "{not json", "utf8");
    expect(readCache()).toBeNull();
  });

  it("writeCacheAtomic creates the directory and writes the file", () => {
    expect(existsSync(currentCacheDir())).toBe(false);
    const entry = { version: 1, timestamp: new Date().toISOString(), repo: REPO, status: "ok" };
    writeCacheAtomic(entry);
    expect(existsSync(currentCacheFile())).toBe(true);
    const round = JSON.parse(readFileSync(currentCacheFile(), "utf8"));
    expect(round).toEqual(entry);
  });

  it("round-trips through readCache", () => {
    const entry = { version: 1, timestamp: new Date().toISOString(), repo: REPO, status: "ok" };
    writeCacheAtomic(entry);
    expect(readCache()).toEqual(entry);
  });

  it("writeCacheAtomic leaves no tmp file behind after success", () => {
    writeCacheAtomic({ version: 1, timestamp: new Date().toISOString(), repo: REPO, status: "ok" });
    const tmp = `${currentCacheFile()}.${process.pid}.tmp`;
    expect(existsSync(tmp)).toBe(false);
  });
});

// ---- autoPreflight -------------------------------------------------------

describe("autoPreflight", () => {
  it("runs doctor on cold cache, writes cache, silent on success", () => {
    mockDoctor(0, { stdout: "ok\n" });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      autoPreflight({ repo: REPO });
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync.mock.calls[0][0]).toBe(DOCTOR_SH);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
      const entry = readCache();
      expect(entry.version).toBe(1);
      expect(entry.repo).toBe(REPO);
      expect(entry.status).toBe("ok");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("skips doctor on warm cache within TTL", () => {
    writeCacheAtomic({
      version: 1,
      timestamp: new Date().toISOString(),
      repo: REPO,
      status: "ok",
    });
    autoPreflight({ repo: REPO });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("runs doctor when cache is stale past TTL", () => {
    writeCacheAtomic({
      version: 1,
      timestamp: new Date(Date.now() - DOCTOR_CACHE_TTL_MS - 1000).toISOString(),
      repo: REPO,
      status: "ok",
    });
    mockDoctor(0, { stdout: "ok\n" });
    autoPreflight({ repo: REPO });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("runs doctor when repo arg differs from cached repo (env-change invalidation)", () => {
    writeCacheAtomic({
      version: 1,
      timestamp: new Date().toISOString(),
      repo: "git@github.com:me/old-store.git",
      status: "ok",
    });
    mockDoctor(0, { stdout: "ok\n" });
    autoPreflight({ repo: REPO });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    // Cache should now reflect the NEW repo.
    expect(readCache().repo).toBe(REPO);
  });

  it("bypasses cache when verify: true is passed", () => {
    writeCacheAtomic({
      version: 1,
      timestamp: new Date().toISOString(),
      repo: REPO,
      status: "ok",
    });
    mockDoctor(0, { stdout: "ok\n" });
    autoPreflight({ repo: REPO, verify: true });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("runs doctor when cached schema version mismatches", () => {
    // Write a version-99 entry directly; writeCacheAtomic always stamps v1.
    mkdirSync(currentCacheDir(), { recursive: true });
    writeFileSync(
      currentCacheFile(),
      JSON.stringify({
        version: 99,
        timestamp: new Date().toISOString(),
        repo: REPO,
        status: "ok",
      }),
      "utf8",
    );
    mockDoctor(0, { stdout: "ok\n" });
    autoPreflight({ repo: REPO });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("throws PreflightHandledError when doctor exits non-zero, does NOT write cache", () => {
    mockDoctor(1, { stderr: "Preflight failed: handoff-repo-unreachable\n" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(() => autoPreflight({ repo: REPO })).toThrow(PreflightHandledError);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Preflight failed: handoff-repo-unreachable"),
      );
      expect(existsSync(currentCacheFile())).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("emits 'cache hit' line to stderr under verbose when warm", () => {
    writeCacheAtomic({
      version: 1,
      timestamp: new Date().toISOString(),
      repo: REPO,
      status: "ok",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      autoPreflight({ repo: REPO, verbose: true });
      expect(spawnSync).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/preflight: cache hit \(age \d+s\)/),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("streams doctor stdout/stderr under verbose on success", () => {
    mockDoctor(0, { stdout: "ok\n", stderr: "info: something\n" });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      autoPreflight({ repo: REPO, verbose: true });
      expect(stdoutSpy).toHaveBeenCalledWith("ok\n");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("info: something"));
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("always streams doctor failure block, even when verbose is false", () => {
    mockDoctor(1, { stdout: "", stderr: "Preflight failed: git-missing\n" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(() => autoPreflight({ repo: REPO, verbose: false })).toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Preflight failed: git-missing"),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
