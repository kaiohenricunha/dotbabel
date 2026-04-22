// Coverage-focused tests for handoff-remote.mjs.
// Mocks node:child_process and node:fs so subprocess / filesystem
// code paths can be exercised without touching the real system.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn().mockReturnValue("/tmp/mock-dir"),
  readFileSync: vi.fn().mockReturnValue(""),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import * as lib from "../src/lib/handoff-remote.mjs";

// ---- helpers -----------------------------------------------------------

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`__exit__${code}`);
  });
}

// ---- runScript ---------------------------------------------------------

describe("runScript", () => {
  it("returns {status, stdout, stderr} on success", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "out\n", stderr: "" });
    const r = lib.runScript("/bin/sh", ["-c", "echo hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("");
  });

  it("falls back to status 2 and empty strings when spawnSync returns nulls", () => {
    spawnSync.mockReturnValueOnce({ status: null, stdout: null, stderr: null });
    const r = lib.runScript("/missing", []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});

// ---- runGit / runGitOrThrow --------------------------------------------

describe("runGit", () => {
  it("invokes spawnSync with git and forwards cwd", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "abc\n", stderr: "" });
    const r = lib.runGit(["rev-parse", "HEAD"], "/tmp");
    expect(spawnSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: "/tmp",
    });
    expect(r.status).toBe(0);
  });
});

describe("runGitOrThrow", () => {
  it("returns the result when git exits 0", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" });
    const r = lib.runGitOrThrow(["status"], "/tmp");
    expect(r.status).toBe(0);
  });

  it("throws a descriptive Error on non-zero exit (stderr preferred)", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "fatal: bad object" });
    expect(() => lib.runGitOrThrow(["show", "HEAD"], "/tmp")).toThrow(
      "git show HEAD failed: fatal: bad object",
    );
  });

  it("falls back to stdout in the thrown message when stderr is empty", () => {
    spawnSync.mockReturnValueOnce({ status: 128, stdout: "hint: something", stderr: "" });
    expect(() => lib.runGitOrThrow(["push"], "/tmp")).toThrow("hint: something");
  });
});

// ---- extractMeta -------------------------------------------------------

describe("extractMeta", () => {
  let exitSpy;
  beforeEach(() => { exitSpy = mockExit(); });
  afterEach(() => exitSpy.mockRestore());

  it("returns parsed JSON meta on success", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '{"cli":"claude","short_id":"ab12cd34"}',
      stderr: "",
    });
    const meta = lib.extractMeta("claude", "/session");
    expect(meta.cli).toBe("claude");
    expect(meta.short_id).toBe("ab12cd34");
  });

  it("exits 2 when the script fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "extract error" });
    expect(() => lib.extractMeta("claude", "/session")).toThrow(/__exit__2/);
  });

  it("exits 2 when output is not valid JSON", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "not-json", stderr: "" });
    expect(() => lib.extractMeta("claude", "/session")).toThrow(/__exit__2/);
  });

  it("exits 2 using the fallback message when script fails with empty stderr", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(() => lib.extractMeta("claude", "/session")).toThrow(/__exit__2/);
  });
});

// ---- extractLines / extractPrompts / extractTurns ----------------------

describe("extractLines", () => {
  it("returns non-empty lines on success", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "line1\nline2\n\n", stderr: "" });
    expect(lib.extractLines("prompts", "claude", "/f")).toEqual(["line1", "line2"]);
  });

  it("returns [] on non-zero exit", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(lib.extractLines("turns", "claude", "/f")).toEqual([]);
  });

  it("writes stderr to process.stderr on failure", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "some error" });
    lib.extractLines("turns", "claude", "/f");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("extractPrompts", () => {
  it("delegates to extractLines with sub=prompts", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "user said hi\n", stderr: "" });
    expect(lib.extractPrompts("claude", "/f")).toEqual(["user said hi"]);
  });
});

describe("extractTurns", () => {
  it("delegates to extractLines with sub=turns (no limit)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "assistant replied\n", stderr: "" });
    expect(lib.extractTurns("claude", "/f")).toEqual(["assistant replied"]);
  });

  it("passes limit as extra arg when provided", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "t1\nt2\n", stderr: "" });
    lib.extractTurns("claude", "/f", 5);
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["5"]),
      expect.anything(),
    );
  });
});

// ---- nextStepFor -------------------------------------------------------

describe("nextStepFor", () => {
  it("returns codex task-specification text", () => {
    expect(lib.nextStepFor("codex")).toContain("task specification");
  });
  it("returns copilot pick-up text", () => {
    expect(lib.nextStepFor("copilot")).toContain("pick up where");
  });
  it("returns default continue text for claude", () => {
    expect(lib.nextStepFor("claude")).toContain("Continue from");
  });
});

// ---- mechanicalSummary -------------------------------------------------

describe("mechanicalSummary", () => {
  it("uses placeholder text when arrays are empty", () => {
    const s = lib.mechanicalSummary([], []);
    expect(s).toContain("(no user prompts captured)");
    expect(s).toContain("(no assistant turns captured)");
  });

  it("clips prompt and turn to 160 chars with ellipsis", () => {
    const long = "a".repeat(300);
    const s = lib.mechanicalSummary([long], [long]);
    expect(s).toContain("…");
  });

  it("uses first prompt and last turn", () => {
    const s = lib.mechanicalSummary(["first", "second"], ["turn1", "turn2"]);
    expect(s).toContain("first");
    expect(s).toContain("turn2");
  });
});

// ---- renderHandoffBlock ------------------------------------------------

describe("renderHandoffBlock", () => {
  const meta = { cli: "claude", short_id: "abc12345", cwd: "/projects/foo" };

  it("wraps content in <handoff> tags", () => {
    const block = lib.renderHandoffBlock(meta, ["p1"], ["t1"], "codex");
    expect(block).toMatch(/^<handoff /);
    expect(block).toContain("</handoff>");
  });

  it("lists prompts and turn tail", () => {
    const block = lib.renderHandoffBlock(meta, ["user prompt"], ["assistant turn"], "claude");
    expect(block).toContain("user prompt");
    expect(block).toContain("assistant turn");
  });

  it("handles empty prompts with fallback text", () => {
    const block = lib.renderHandoffBlock(meta, [], [], "claude");
    expect(block).toContain("(no user prompts captured)");
    expect(block).toContain("_(no assistant output captured)_");
  });

  it("caps prompts at last 10", () => {
    const prompts = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const block = lib.renderHandoffBlock(meta, prompts, [], "claude");
    expect(block).toContain("10. p14");
    expect(block).not.toContain("11. ");
  });

  it("truncates long prompts at 300 chars", () => {
    const long = "x".repeat(500);
    const block = lib.renderHandoffBlock(meta, [long], [], "claude");
    expect(block).toContain("…");
  });

  it("truncates long turns at 400 chars", () => {
    const long = "y".repeat(600);
    const block = lib.renderHandoffBlock(meta, [], [long], "claude");
    expect(block).toContain("…");
  });
});

// ---- isTty -------------------------------------------------------------

describe("isTty", () => {
  it("returns false when stdin is not a TTY (test environment)", () => {
    expect(lib.isTty()).toBe(false);
  });
});

// ---- encodeDescription / decodeDescription -----------------------------

describe("encodeDescription", () => {
  let exitSpy;
  beforeEach(() => { exitSpy = mockExit(); });
  afterEach(() => exitSpy.mockRestore());

  it("returns the trimmed encoded string on success", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "handoff:v2:claude/abc/proj/host\n",
      stderr: "",
    });
    const result = lib.encodeDescription({
      cli: "claude",
      shortId: "abc",
      project: "proj",
      host: "host",
      month: "2026-04",
      tag: null,
    });
    expect(result).toBe("handoff:v2:claude/abc/proj/host");
  });

  it("includes tag arg when tag is provided", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "encoded\n", stderr: "" });
    lib.encodeDescription({
      cli: "claude", shortId: "abc", project: "proj", host: "host", month: "2026-04", tag: "mywork",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--tag", "mywork"]),
      expect.anything(),
    );
  });

  it("exits 2 on encode failure", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "encode failed" });
    expect(() => lib.encodeDescription({
      cli: "claude", shortId: "x", project: "p", host: "h", month: "2026-04", tag: null,
    })).toThrow(/__exit__2/);
  });
});

describe("decodeDescription", () => {
  it("returns null for null input", () => {
    expect(lib.decodeDescription(null)).toBeNull();
  });

  it("returns null for non-handoff prefix", () => {
    expect(lib.decodeDescription("other:blah")).toBeNull();
  });

  it("parses v2 descriptions", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '{"cli":"claude","shortId":"abc"}',
      stderr: "",
    });
    const result = lib.decodeDescription("handoff:v2:claude/abc/proj/host");
    expect(result).toEqual({ cli: "claude", shortId: "abc" });
  });

  it("parses v1 descriptions", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '{"cli":"codex"}',
      stderr: "",
    });
    expect(lib.decodeDescription("handoff:v1:codex/abc")).toEqual({ cli: "codex" });
  });

  it("returns null when script exits non-zero", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(lib.decodeDescription("handoff:v2:x")).toBeNull();
  });

  it("returns null when output is invalid JSON", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "not-json", stderr: "" });
    expect(lib.decodeDescription("handoff:v2:x")).toBeNull();
  });
});

// ---- ghAvailable / ghAuthenticated / ghLogin ---------------------------

describe("ghAvailable", () => {
  it("returns true when gh exits 0", () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    expect(lib.ghAvailable()).toBe(true);
  });

  it("returns false when gh exits non-zero", () => {
    spawnSync.mockReturnValueOnce({ status: 127 });
    expect(lib.ghAvailable()).toBe(false);
  });
});

describe("ghAuthenticated", () => {
  it("returns true on successful auth status", () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    expect(lib.ghAuthenticated()).toBe(true);
  });

  it("returns false when auth status fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1 });
    expect(lib.ghAuthenticated()).toBe(false);
  });
});

describe("ghLogin", () => {
  it("returns trimmed login on success", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "octocat\n" });
    expect(lib.ghLogin()).toBe("octocat");
  });

  it("returns null when gh fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "" });
    expect(lib.ghLogin()).toBeNull();
  });

  it("returns null when output is empty", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "" });
    expect(lib.ghLogin()).toBeNull();
  });
});

// ---- printManualSetupBlock ---------------------------------------------

describe("printManualSetupBlock", () => {
  it("writes setup instructions to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    lib.printManualSetupBlock("no tty");
    const out = spy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("no tty");
    expect(out).toContain("DOTCLAUDE_HANDOFF_REPO");
    spy.mockRestore();
  });
});

// ---- loadPersistedEnv --------------------------------------------------

describe("loadPersistedEnv", () => {
  afterEach(() => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("does nothing when config file does not exist", () => {
    existsSync.mockReturnValueOnce(false);
    expect(() => lib.loadPersistedEnv()).not.toThrow();
  });

  it("sets env vars from file content (quoted)", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce(
      'export DOTCLAUDE_HANDOFF_REPO="git@github.com:x/y.git"\n',
    );
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("git@github.com:x/y.git");
  });

  it("sets env vars from file content (bare value)", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTCLAUDE_HANDOFF_REPO=https://example.com/x.git\n");
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("https://example.com/x.git");
  });

  it("skips comment lines and blank lines", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("# comment\n\nDOTCLAUDE_HANDOFF_REPO=val\n");
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("val");
  });

  it("does not overwrite an already-set env var", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTCLAUDE_HANDOFF_REPO=new-val\n");
    process.env.DOTCLAUDE_HANDOFF_REPO = "existing";
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("existing");
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("strips single-quoted values", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTCLAUDE_HANDOFF_REPO='git@github.com:x/y.git'\n");
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("git@github.com:x/y.git");
  });

  it("swallows a readFileSync error silently", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(() => lib.loadPersistedEnv()).not.toThrow();
  });

  it("skips lines that do not match the VAR=VAL pattern", () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("not-valid-line\nDOTCLAUDE_HANDOFF_REPO=good-val\n");
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBe("good-val");
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    const origXDG = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/test-xdg-config";
    existsSync.mockReturnValueOnce(false);
    try {
      expect(() => lib.loadPersistedEnv()).not.toThrow();
    } finally {
      if (origXDG !== undefined) {
        process.env.XDG_CONFIG_HOME = origXDG;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
    }
  });

  it("falls back to HOME when XDG_CONFIG_HOME is unset", () => {
    const origXDG = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    existsSync.mockReturnValueOnce(false);
    expect(() => lib.loadPersistedEnv()).not.toThrow();
    if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
  });

  it("falls back to empty string when both XDG_CONFIG_HOME and HOME are unset", () => {
    const origXDG = process.env.XDG_CONFIG_HOME;
    const origHOME = process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.HOME;
    existsSync.mockReturnValueOnce(false);
    try {
      expect(() => lib.loadPersistedEnv()).not.toThrow();
    } finally {
      if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
      if (origHOME !== undefined) process.env.HOME = origHOME;
    }
  });
});

// ---- requireTransportRepoStrict ----------------------------------------

describe("requireTransportRepoStrict", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("returns the URL when env var is set", () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    expect(lib.requireTransportRepoStrict()).toBe("https://github.com/x/y.git");
  });

  it("exits 2 when env var is absent", () => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    expect(() => lib.requireTransportRepoStrict()).toThrow(/__exit__2/);
  });
});

// ---- projectSlugFromCwd ------------------------------------------------

describe("projectSlugFromCwd", () => {
  it("returns adhoc for falsy cwd", () => {
    expect(lib.projectSlugFromCwd(null)).toBe("adhoc");
    expect(lib.projectSlugFromCwd("")).toBe("adhoc");
  });

  it("returns slugified git root basename", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "/home/user/my-repo\n", stderr: "" });
    expect(lib.projectSlugFromCwd("/home/user/my-repo/sub")).toBe("my-repo");
  });

  it("falls back to slugified cwd basename when git fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(lib.projectSlugFromCwd("/home/user/fallback-dir")).toBe("fallback-dir");
  });

  it("returns adhoc when cwd is a bare root slash (pop returns undefined)", () => {
    // "/" splits to ["",""] → filter(Boolean) → [] → pop() = undefined → || "adhoc"
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(lib.projectSlugFromCwd("/")).toBe("adhoc");
  });
});

// ---- listRemoteCandidates ----------------------------------------------

describe("listRemoteCandidates", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("returns parsed candidates from ls-remote output", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc123  refs/heads/handoff/proj/claude/2026-04/abcd1234\n",
      stderr: "",
    });
    const cands = lib.listRemoteCandidates();
    expect(cands).toHaveLength(1);
    expect(cands[0].branch).toBe("handoff/proj/claude/2026-04/abcd1234");
    expect(cands[0].commit).toBe("abc123");
    expect(cands[0].description).toBe("");
  });

  it("returns empty array for empty ls-remote output", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(lib.listRemoteCandidates()).toEqual([]);
  });

  it("exits 2 on ls-remote failure", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "auth failed" });
    expect(() => lib.listRemoteCandidates()).toThrow(/__exit__2/);
  });

  it("skips malformed lines (not exactly 2 parts)", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "just-one-word\nabc  refs/heads/handoff/p/c/2026-04/x\n",
      stderr: "",
    });
    const cands = lib.listRemoteCandidates();
    expect(cands).toHaveLength(1);
  });
});

// ---- fetchRemoteBranch -------------------------------------------------

describe("fetchRemoteBranch", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    vi.clearAllMocks();
  });

  it("returns content and description on success", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone
    existsSync.mockReturnValueOnce(true);  // handoff.md exists
    readFileSync.mockReturnValueOnce("# Handoff content");  // handoff.md
    existsSync.mockReturnValueOnce(true);  // description.txt exists
    readFileSync.mockReturnValueOnce("handoff:v2:claude/abc/proj/host");  // description.txt
    const result = lib.fetchRemoteBranch("handoff/proj/claude/2026-04/abc12345");
    expect(result.content).toBe("# Handoff content");
    expect(result.description).toBe("handoff:v2:claude/abc/proj/host");
  });

  it("returns empty description when description.txt is absent", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull2");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone
    existsSync.mockReturnValueOnce(true);   // handoff.md exists
    readFileSync.mockReturnValueOnce("# Content");
    existsSync.mockReturnValueOnce(false);  // description.txt absent
    const result = lib.fetchRemoteBranch("handoff/proj/claude/2026-04/abc12345");
    expect(result.description).toBe("");
  });

  it("throws when clone fails", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull3");
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "clone failed" });
    expect(() => lib.fetchRemoteBranch("handoff/proj/claude/2026-04/abc12345")).toThrow(
      "clone --branch handoff/proj/claude/2026-04/abc12345 failed",
    );
  });

  it("throws when handoff.md is missing after clone", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull4");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone ok
    existsSync.mockReturnValueOnce(false);  // handoff.md missing
    expect(() => lib.fetchRemoteBranch("handoff/proj/claude/2026-04/abc12345")).toThrow(
      "handoff.md missing",
    );
  });
});

// ---- enrichWithDescriptions --------------------------------------------

describe("enrichWithDescriptions", () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.clearAllMocks();
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("enriches candidates with descriptions from fetchRemoteBranch", () => {
    mkdtempSync.mockReturnValue("/tmp/enrich-1");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("content");
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("handoff:v2:claude/abc/proj/host");
    const result = lib.enrichWithDescriptions([{ branch: "handoff/proj/claude/2026-04/abc", commit: "abc123", description: "" }]);
    expect(result[0].description).toBe("handoff:v2:claude/abc/proj/host");
  });

  it("keeps the original candidate when fetchRemoteBranch throws", () => {
    mkdtempSync.mockReturnValue("/tmp/enrich-2");
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "clone failed" });
    const original = { branch: "handoff/proj/claude/2026-04/abc", commit: "abc123", description: "original" };
    const result = lib.enrichWithDescriptions([original]);
    expect(result[0].description).toBe("original");
  });
});

// ---- pullRemote --------------------------------------------------------

describe("pullRemote", () => {
  let exitSpy;
  let stderrSpy;

  function resetMockQueues() {
    // mockReset() flushes mockReturnValueOnce queues AND clears implementations;
    // re-establish defaults so un-queued calls return harmless values.
    spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    existsSync.mockReset().mockReturnValue(false);
    readFileSync.mockReset().mockReturnValue("");
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-dir");
  }

  function mockLsRemote(branch = "handoff/proj/claude/2026-04/abc12345") {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: `abc123  refs/heads/${branch}\n`,
      stderr: "",
    });
  }

  function mockFetchBranch(content = "# content", description = "handoff:v2:claude/abc/proj/host") {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone
    existsSync.mockReturnValueOnce(true);  // handoff.md exists
    readFileSync.mockReturnValueOnce(content);
    existsSync.mockReturnValueOnce(true);  // description.txt exists
    readFileSync.mockReturnValueOnce(description);
  }

  beforeEach(() => {
    resetMockQueues();
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("returns the last candidate when query is null (no enrichment)", async () => {
    mockLsRemote("handoff/proj/claude/2026-04/abc12345");
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/abc12345");
  });

  it("exits 2 when no candidates exist", async () => {
    // Override: ls-remote returns empty output → candidates = []
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    await expect(lib.pullRemote(null)).rejects.toThrow(/__exit__2/);
  });

  it("filters by fromCli when provided, returning only the matching CLI's branch", async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: [
        "abc  refs/heads/handoff/proj/claude/2026-04/aaa",
        "def  refs/heads/handoff/proj/copilot/2026-04/bbb",
      ].join("\n") + "\n",
      stderr: "",
    });
    const result = await lib.pullRemote(null, "claude");
    expect(result.branch).toContain("claude");
  });

  it("exits 2 when fromCli filter yields no candidates", async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc  refs/heads/handoff/proj/copilot/2026-04/aaa\n",
      stderr: "",
    });
    await expect(lib.pullRemote(null, "claude")).rejects.toThrow(/__exit__2/);
  });

  it("matches by query against branch name and returns the single hit", async () => {
    mockLsRemote("handoff/proj/claude/2026-04/abc12345");
    mockFetchBranch();
    const result = await lib.pullRemote("abc12345");
    expect(result.branch).toContain("abc12345");
  });

  it("falls through to description-enriched search when branch name doesn't match", async () => {
    // The branch name doesn't contain "myproject" but the description will.
    // Path: hits=[] → enrichWithDescriptions(candidates) → re-match → 1 hit → return
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc  refs/heads/handoff/proj/claude/2026-04/abc12345\n",
      stderr: "",
    });
    mockFetchBranch("content", "handoff:v2:claude/abc/myproject/host");
    const result = await lib.pullRemote("myproject");
    expect(result.description).toContain("myproject");
  });

  it("exits 2 when no candidates match the query after description enrichment", async () => {
    // Branch name and description both don't contain the query.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc  refs/heads/handoff/proj/claude/2026-04/abc12345\n",
      stderr: "",
    });
    mockFetchBranch("content", "handoff:v2:claude/abc/proj/host");
    await expect(lib.pullRemote("zzz-no-match")).rejects.toThrow(/__exit__2/);
  });

  it("exits 2 on non-TTY collision when multiple hits share the query", async () => {
    // Two branches both containing "abc" in the name.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: [
        "aaa  refs/heads/handoff/proj/claude/2026-04/abc12345",
        "bbb  refs/heads/handoff/proj/claude/2026-04/abc67890",
      ].join("\n") + "\n",
      stderr: "",
    });
    // enrichWithDescriptions is called for both hits (both match on branch name)
    mockFetchBranch("c1", "");
    mockFetchBranch("c2", "");
    // stdin is not a TTY in tests → non-TTY collision → process.exit(2)
    await expect(lib.pullRemote("abc")).rejects.toThrow(/__exit__2/);
  });

  it("resolves a TTY collision when user picks a valid item", async () => {
    // Two hits, user answers "1" → returns hits[0].
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: [
        "aaa  refs/heads/handoff/proj/claude/2026-04/abc12345",
        "bbb  refs/heads/handoff/proj/claude/2026-04/abc67890",
      ].join("\n") + "\n",
      stderr: "",
    });
    mockFetchBranch("c1", "handoff:v2:claude/abc/proj/host");
    mockFetchBranch("c2", "handoff:v2:claude/abc/proj/host");

    // Make createInterface return an rl that answers "1" immediately.
    createInterface.mockReturnValueOnce({
      question: (_prompt, cb) => cb("1"),
      close: vi.fn(),
    });

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const result = await lib.pullRemote("abc");
      expect(result.branch).toContain("abc12345");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
  });

  it("exits 2 on TTY collision when user enters an invalid pick", async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: [
        "aaa  refs/heads/handoff/proj/claude/2026-04/abc12345",
        "bbb  refs/heads/handoff/proj/claude/2026-04/abc67890",
      ].join("\n") + "\n",
      stderr: "",
    });
    mockFetchBranch("c1", "handoff:v2:claude/abc/proj/host");
    mockFetchBranch("c2", "handoff:v2:claude/abc/proj/host");

    createInterface.mockReturnValueOnce({
      question: (_prompt, cb) => cb("x"),  // non-numeric → abort
      close: vi.fn(),
    });

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await expect(lib.pullRemote("abc")).rejects.toThrow(/__exit__2/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
  });
});

// ---- bootstrapTransportRepo — TTY early-exit paths ---------------------

describe("bootstrapTransportRepo — TTY early-exit paths", () => {
  let exitSpy;
  let stderrSpy;
  let origIsTTY;

  beforeEach(() => {
    origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__exit__${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits 2 when gh is not available", async () => {
    // isTty() → true; ghAvailable() → false
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    await expect(lib.bootstrapTransportRepo()).rejects.toThrow(/__exit__2/);
  });

  it("exits 2 when gh is available but not authenticated", async () => {
    // isTty() → true; ghAvailable() → true; ghAuthenticated() → false
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "gh version 2\n", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    await expect(lib.bootstrapTransportRepo()).rejects.toThrow(/__exit__2/);
  });

  it("exits 2 when gh is authenticated but login returns null", async () => {
    // isTty() → true; ghAvailable() → true; ghAuthenticated() → true; ghLogin() → null
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "gh version 2\n", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    await expect(lib.bootstrapTransportRepo()).rejects.toThrow(/__exit__2/);
  });
});
