// Table-driven matrix for requireTransportRepo — the URL-scheme guard that
// rejects ext::, data:, javascript:, and other exec-triggering Git URLs
// (CVE-2017-1000117-class), while allowing https/http/ssh/git@/file:// and
// absolute filesystem paths (bare repos).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requireTransportRepo } from "../bin/dotclaude-handoff.mjs";

describe("requireTransportRepo", () => {
  let exitSpy;
  let stderrSpy;
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.DOTCLAUDE_HANDOFF_REPO;
    // Stub process.exit so fail() throws instead of ending the test runner.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    if (savedEnv === undefined) delete process.env.DOTCLAUDE_HANDOFF_REPO;
    else process.env.DOTCLAUDE_HANDOFF_REPO = savedEnv;
  });

  const accepted = [
    ["https URL",          "https://github.com/x/y.git"],
    ["http URL",           "http://ghe.example.com/x/y.git"],
    ["git@ SSH shorthand", "git@github.com:x/y.git"],
    ["ssh:// URL",         "ssh://git@host:22/x.git"],
    ["file:// URL",        "file:///tmp/bare.git"],
    ["absolute path",      "/tmp/bare-repo"],
  ];

  for (const [label, url] of accepted) {
    it(`accepts ${label}`, () => {
      process.env.DOTCLAUDE_HANDOFF_REPO = url;
      expect(requireTransportRepo()).toBe(url);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  }

  const rejected = [
    ["ext:: exec scheme",     "ext::sh -c evil"],
    ["data: URI",             "data:text/plain,x"],
    ["javascript: URI",       "javascript:alert(1)"],
    ["relative path",         "relative/path/to/repo"],
    ["bare hostname",         "github.com/x/y"],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      process.env.DOTCLAUDE_HANDOFF_REPO = url;
      expect(() => requireTransportRepo()).toThrow(/__exit__2/);
      expect(stderrSpy).toHaveBeenCalled();
      // The failure message must name the offending URL so the operator
      // can see what was rejected.
      const stderrArgs = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(stderrArgs).toContain(url);
    });
  }

  it("rejects unset env with a clear error", () => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    expect(() => requireTransportRepo()).toThrow(/__exit__2/);
    const stderrArgs = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderrArgs).toContain("DOTCLAUDE_HANDOFF_REPO");
  });

  it("rejects empty string env", () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "";
    expect(() => requireTransportRepo()).toThrow(/__exit__2/);
  });
});
