// Asserts that pushRemote and pullRemote invoke autoPreflight with the resolved
// repo URL and the {verify, verbose} opts, before any transport I/O. Mocks
// autoPreflight to short-circuit so we don't need to stub git/fs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/lib/handoff-preflight.mjs", () => ({
  autoPreflight: vi.fn(),
  // Re-export constants the consumer module reads at import time (none today,
  // but keep the mock complete so future additions don't silently regress).
  CACHE_SCHEMA_VERSION: 1,
  DOCTOR_CACHE_TTL_MS: 5 * 60 * 1000,
  DOCTOR_SH: "/unused-in-tests",
  currentCacheDir: vi.fn(() => "/tmp/unused"),
  currentCacheFile: vi.fn(() => "/tmp/unused/handoff-doctor.json"),
  isFresh: vi.fn(() => false),
  readCache: vi.fn(() => null),
  writeCacheAtomic: vi.fn(),
}));

import { autoPreflight } from "../src/lib/handoff-preflight.mjs";
import * as lib from "../src/lib/handoff-remote.mjs";

const REPO_URL = "https://github.com/x/y.git";

describe("pushRemote wires autoPreflight", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    autoPreflight.mockReset();
    // Short-circuit pushRemote right after preflight by throwing a sentinel.
    autoPreflight.mockImplementation(() => {
      throw new Error("__preflight_short_circuit__");
    });
    process.env.DOTCLAUDE_HANDOFF_REPO = REPO_URL;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("calls autoPreflight with the resolved repo URL before any transport I/O", async () => {
    await expect(
      lib.pushRemote({ cli: "claude", path: "/tmp/nonexistent" }),
    ).rejects.toThrow("__preflight_short_circuit__");

    expect(autoPreflight).toHaveBeenCalledTimes(1);
    const call = autoPreflight.mock.calls[0][0];
    expect(call.repo).toBe(REPO_URL);
    expect(call.verify).toBe(false);
    expect(call.verbose).toBe(false);
  });

  it("forwards verify:true and verbose:true to autoPreflight", async () => {
    await expect(
      lib.pushRemote({
        cli: "claude",
        path: "/tmp/nonexistent",
        verify: true,
        verbose: true,
      }),
    ).rejects.toThrow("__preflight_short_circuit__");

    const call = autoPreflight.mock.calls[0][0];
    expect(call.verify).toBe(true);
    expect(call.verbose).toBe(true);
  });
});

describe("pullRemote wires autoPreflight", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    autoPreflight.mockReset();
    autoPreflight.mockImplementation(() => {
      throw new Error("__preflight_short_circuit__");
    });
    process.env.DOTCLAUDE_HANDOFF_REPO = REPO_URL;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("calls autoPreflight with the resolved repo URL before listing candidates", async () => {
    await expect(lib.pullRemote(null)).rejects.toThrow(
      "__preflight_short_circuit__",
    );

    expect(autoPreflight).toHaveBeenCalledTimes(1);
    const call = autoPreflight.mock.calls[0][0];
    expect(call.repo).toBe(REPO_URL);
    expect(call.verify).toBe(false);
    expect(call.verbose).toBe(false);
  });

  it("forwards verify:true and verbose:true to autoPreflight", async () => {
    await expect(
      lib.pullRemote(null, null, { verify: true, verbose: true }),
    ).rejects.toThrow("__preflight_short_circuit__");

    const call = autoPreflight.mock.calls[0][0];
    expect(call.verify).toBe(true);
    expect(call.verbose).toBe(true);
  });
});
