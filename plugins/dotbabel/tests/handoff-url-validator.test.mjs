// Table-driven matrix for the transport-URL scheme guard that rejects
// ext::, data:, javascript:, and other exec-triggering Git URLs
// (CVE-2017-1000117-class), while allowing https/http/ssh/git@/file://
// and absolute filesystem paths (bare repos).
//
// The interactive bootstrap path (`requireTransportRepo`, which may
// shell out to `gh`) lives in handoff-bootstrap.test.mjs. Here we only
// hit the sync URL-shape validator and its strict companion.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateTransportUrl,
  requireTransportRepoStrict,
  HandoffError,
} from "../bin/dotbabel-handoff.mjs";

describe("validateTransportUrl", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const accepted = [
    ["https URL", "https://github.com/x/y.git"],
    ["http URL", "http://ghe.example.com/x/y.git"],
    ["git@ SSH shorthand", "git@github.com:x/y.git"],
    ["ssh:// URL", "ssh://git@host:22/x.git"],
    ["file:// URL", "file:///tmp/bare.git"],
    ["absolute path", "/tmp/bare-repo"],
  ];

  for (const [label, url] of accepted) {
    it(`accepts ${label}`, () => {
      expect(validateTransportUrl(url)).toBe(url);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  }

  const rejected = [
    ["ext:: exec scheme", "ext::sh -c evil"],
    ["data: URI", "data:text/plain,x"],
    ["javascript: URI", "javascript:alert(1)"],
    ["relative path", "relative/path/to/repo"],
    ["bare hostname", "github.com/x/y"],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => validateTransportUrl(url)).toThrow(/__exit__2/);
      expect(stderrSpy).toHaveBeenCalled();
      const stderrArgs = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(stderrArgs).toContain(url);
    });
  }
});

describe("requireTransportRepoStrict", () => {
  let exitSpy;
  let stderrSpy;
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.DOTBABEL_HANDOFF_REPO;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    if (savedEnv === undefined) delete process.env.DOTBABEL_HANDOFF_REPO;
    else process.env.DOTBABEL_HANDOFF_REPO = savedEnv;
  });

  it("returns the URL when set and well-formed", () => {
    process.env.DOTBABEL_HANDOFF_REPO = "git@github.com:x/y.git";
    expect(requireTransportRepoStrict()).toBe("git@github.com:x/y.git");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects unset env with a clear pointer at push auto-bootstrap", () => {
    delete process.env.DOTBABEL_HANDOFF_REPO;
    let err;
    try {
      requireTransportRepoStrict();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HandoffError);
    expect(err.fix).toContain("DOTBABEL_HANDOFF_REPO");
    expect(err.fix).toContain("push");
  });

  it("rejects empty string env", () => {
    process.env.DOTBABEL_HANDOFF_REPO = "";
    expect(() => requireTransportRepoStrict()).toThrow(HandoffError);
  });
});
