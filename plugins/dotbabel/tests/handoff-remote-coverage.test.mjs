// Coverage-focused tests for handoff-remote.mjs.
// Mocks node:child_process and node:fs so subprocess / filesystem
// code paths can be exercised without touching the real system.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HandoffError } from "../src/lib/handoff-errors.mjs";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn().mockReturnValue("/tmp/mock-dir"),
  readFileSync: vi.fn().mockReturnValue(""),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
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
  beforeEach(() => {
    exitSpy = mockExit();
  });
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
  it("parses JSON-encoded strings, one per line, preserving embedded newlines", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '"line1"\n"multi\\nline"\n\n',
      stderr: "",
    });
    expect(lib.extractLines("prompts", "claude", "/f")).toEqual(["line1", "multi\nline"]);
  });

  it("skips malformed lines without crashing", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '"ok"\nnot-json\n"also-ok"\n',
      stderr: "",
    });
    expect(lib.extractLines("prompts", "claude", "/f")).toEqual(["ok", "also-ok"]);
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
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '"user said hi"\n', stderr: "" });
    expect(lib.extractPrompts("claude", "/f")).toEqual(["user said hi"]);
  });
});

describe("extractTurns", () => {
  it("delegates to extractLines with sub=turns (no limit)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '"assistant replied"\n', stderr: "" });
    expect(lib.extractTurns("claude", "/f")).toEqual(["assistant replied"]);
  });

  it("passes limit as extra arg when provided", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '"t1"\n"t2"\n', stderr: "" });
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
    expect(s).toContain("(session contained no user prompts)");
    expect(s).toContain("(session contained no assistant turns)");
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
    expect(block).toContain("(session contained no user prompts)");
    expect(block).toContain("_(session contained no assistant turns)_");
  });

  it("renders all prompts when below the 50-prompt cap", () => {
    const prompts = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const block = lib.renderHandoffBlock(meta, prompts, [], "claude");
    expect(block).toContain("1. p0");
    expect(block).toContain("15. p14");
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
  beforeEach(() => {
    exitSpy = mockExit();
  });
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
      cli: "claude",
      shortId: "abc",
      project: "proj",
      host: "host",
      month: "2026-04",
      tag: "mywork",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--tag", "mywork"]),
      expect.anything(),
    );
  });

  it("exits 2 on encode failure", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "encode failed" });
    expect(() =>
      lib.encodeDescription({
        cli: "claude",
        shortId: "x",
        project: "p",
        host: "h",
        month: "2026-04",
        tag: null,
      }),
    ).toThrow(/__exit__2/);
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
    expect(out).toContain("DOTBABEL_HANDOFF_REPO");
    spy.mockRestore();
  });
});

// ---- loadPersistedEnv --------------------------------------------------

describe("loadPersistedEnv", () => {
  // currentConfigFile() now resolves through legacy-compat's configDir(),
  // which probes existsSync() once on the canonical path before returning.
  // Each test that wants loadPersistedEnv to actually read a file therefore
  // needs TWO queued mockReturnValueOnce(true) calls: the first satisfies
  // legacy-compat's canonical-exists probe (so it returns the canonical path
  // without further probing), the second satisfies loadPersistedEnv's own
  // existsSync(configFile) check.

  afterEach(() => {
    delete process.env.DOTBABEL_HANDOFF_REPO;
    // Drain any unconsumed mocks so they don't leak into the next describe
    // (vi.clearAllMocks at the test-file level only runs in describes that
    // explicitly call it).
    vi.clearAllMocks();
  });

  it("does nothing when config file does not exist", () => {
    existsSync.mockReturnValueOnce(true);  // legacy-compat canonical probe
    existsSync.mockReturnValueOnce(false); // loadPersistedEnv's own check
    expect(() => lib.loadPersistedEnv()).not.toThrow();
  });

  it("sets env vars from file content (quoted)", () => {
    existsSync.mockReturnValueOnce(true);  // legacy-compat probe
    existsSync.mockReturnValueOnce(true);  // loadPersistedEnv's check
    readFileSync.mockReturnValueOnce('export DOTBABEL_HANDOFF_REPO="git@github.com:x/y.git"\n');
    delete process.env.DOTBABEL_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("git@github.com:x/y.git");
  });

  it("sets env vars from file content (bare value)", () => {
    existsSync.mockReturnValueOnce(true);
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTBABEL_HANDOFF_REPO=https://example.com/x.git\n");
    delete process.env.DOTBABEL_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("https://example.com/x.git");
  });

  it("skips comment lines and blank lines", () => {
    existsSync.mockReturnValueOnce(true);
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("# comment\n\nDOTBABEL_HANDOFF_REPO=val\n");
    delete process.env.DOTBABEL_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("val");
  });

  it("does not overwrite an already-set env var", () => {
    existsSync.mockReturnValueOnce(true);
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTBABEL_HANDOFF_REPO=new-val\n");
    process.env.DOTBABEL_HANDOFF_REPO = "existing";
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("existing");
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("strips single-quoted values", () => {
    existsSync.mockReturnValueOnce(true);
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("DOTBABEL_HANDOFF_REPO='git@github.com:x/y.git'\n");
    delete process.env.DOTBABEL_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("git@github.com:x/y.git");
  });

  it("swallows a readFileSync error silently", () => {
    existsSync.mockReturnValueOnce(true);  // legacy-compat probe
    existsSync.mockReturnValueOnce(true);  // loadPersistedEnv's check
    readFileSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => lib.loadPersistedEnv()).not.toThrow();
  });

  it("skips lines that do not match the VAR=VAL pattern", () => {
    existsSync.mockReturnValueOnce(true);
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("not-valid-line\nDOTBABEL_HANDOFF_REPO=good-val\n");
    delete process.env.DOTBABEL_HANDOFF_REPO;
    lib.loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("good-val");
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
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("returns the URL when env var is set", () => {
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    expect(lib.requireTransportRepoStrict()).toBe("https://github.com/x/y.git");
  });

  it("throws HandoffError when env var is absent", () => {
    delete process.env.DOTBABEL_HANDOFF_REPO;
    expect(() => lib.requireTransportRepoStrict()).toThrow(HandoffError);
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
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTBABEL_HANDOFF_REPO;
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

  it("throws HandoffError on ls-remote failure", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "auth failed" });
    expect(() => lib.listRemoteCandidates()).toThrow(HandoffError);
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
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTBABEL_HANDOFF_REPO;
    vi.clearAllMocks();
  });

  it("returns content and description on success", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone
    existsSync.mockReturnValueOnce(true); // handoff.md exists
    readFileSync.mockReturnValueOnce("# Handoff content"); // handoff.md
    existsSync.mockReturnValueOnce(true); // description.txt exists
    readFileSync.mockReturnValueOnce("handoff:v2:claude/abc/proj/host"); // description.txt
    const result = lib.fetchRemoteBranch("handoff/proj/claude/2026-04/abc12345");
    expect(result.content).toBe("# Handoff content");
    expect(result.description).toBe("handoff:v2:claude/abc/proj/host");
  });

  it("returns empty description when description.txt is absent", () => {
    mkdtempSync.mockReturnValue("/tmp/mock-pull2");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // clone
    existsSync.mockReturnValueOnce(true); // handoff.md exists
    readFileSync.mockReturnValueOnce("# Content");
    existsSync.mockReturnValueOnce(false); // description.txt absent
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
    existsSync.mockReturnValueOnce(false); // handoff.md missing
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
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.clearAllMocks();
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("enriches candidates with descriptions from fetchRemoteBranch", () => {
    mkdtempSync.mockReturnValue("/tmp/enrich-1");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("content");
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("handoff:v2:claude/abc/proj/host");
    const result = lib.enrichWithDescriptions([
      { branch: "handoff/proj/claude/2026-04/abc", commit: "abc123", description: "" },
    ]);
    expect(result[0].description).toBe("handoff:v2:claude/abc/proj/host");
  });

  it("keeps the original candidate when fetchRemoteBranch throws", () => {
    mkdtempSync.mockReturnValue("/tmp/enrich-2");
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "clone failed" });
    const original = {
      branch: "handoff/proj/claude/2026-04/abc",
      commit: "abc123",
      description: "original",
    };
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
    existsSync.mockReturnValueOnce(true); // handoff.md exists
    readFileSync.mockReturnValueOnce(content);
    existsSync.mockReturnValueOnce(true); // description.txt exists
    readFileSync.mockReturnValueOnce(description);
  }

  // Preflight runs first on pullRemote and reads the doctor cache via
  // existsSync + readFileSync. Prime a cache-hit so preflight returns silently
  // and does not consume any spawnSync mock that was queued for ls-remote.
  function primePreflightCacheHit() {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce(
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        repo: "https://github.com/x/y.git",
        status: "ok",
      }),
    );
  }

  beforeEach(() => {
    resetMockQueues();
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    primePreflightCacheHit();
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("returns the single candidate when query is null (sort short-circuits on N=1)", async () => {
    mockLsRemote("handoff/proj/claude/2026-04/abc12345");
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/abc12345");
  });

  // ---- sortByCommitterDate via bare pullRemote ----
  //
  // Each test below mocks an ls-remote with 2–3 candidates, then queues
  // spawnSync returns for `git init` / `git fetch` / `git for-each-ref`
  // in that exact order. On fallback, sortByCommitterDate returns null
  // and pullRemote falls back to candidates[candidates.length - 1] —
  // the last ls-remote entry, preserving pre-fix selection semantics.
  // The stderr warning signals the user that the pick is best-effort.

  function mockLsRemoteMulti(...shortIds) {
    const lines =
      shortIds.map((s, i) => `c${i}  refs/heads/handoff/proj/claude/2026-04/${s}`).join("\n") +
      "\n";
    spawnSync.mockReturnValueOnce({ status: 0, stdout: lines, stderr: "" });
  }

  it("sorts bare pull candidates by committer date (newest first)", async () => {
    mockLsRemoteMulti("aaaaaaaa", "bbbbbbbb", "cccccccc");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // fetch
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout:
        [
          "handoff/proj/claude/2026-04/bbbbbbbb",
          "handoff/proj/claude/2026-04/aaaaaaaa",
          "handoff/proj/claude/2026-04/cccccccc",
        ].join("\n") + "\n",
      stderr: "",
    }); // for-each-ref: bbb is newest
    const result = await lib.pullRemote(null);
    // Pre-fix would return 'cccccccc' (lex-last); the fix returns the
    // first entry of for-each-ref --sort=-committerdate output.
    expect(result.branch).toBe("handoff/proj/claude/2026-04/bbbbbbbb");
  });

  it("falls back to ls-remote order when `git init` fails during sort", async () => {
    mockLsRemoteMulti("aaaaaaaa", "bbbbbbbb");
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "init denied" });
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/bbbbbbbb");
  });

  it("falls back to ls-remote order when the shallow fetch fails during sort", async () => {
    mockLsRemoteMulti("aaaaaaaa", "bbbbbbbb");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 128, stdout: "", stderr: "remote hung up" });
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/bbbbbbbb");
  });

  it("falls back to ls-remote order when `for-each-ref` fails during sort", async () => {
    mockLsRemoteMulti("aaaaaaaa", "bbbbbbbb");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // fetch
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "bad ref" });
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/bbbbbbbb");
  });

  it("falls back when for-each-ref returns fewer refs than candidates (partial)", async () => {
    mockLsRemoteMulti("aaaaaaaa", "bbbbbbbb");
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // fetch
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "handoff/proj/claude/2026-04/aaaaaaaa\n", // only one of two
      stderr: "",
    });
    const result = await lib.pullRemote(null);
    expect(result.branch).toBe("handoff/proj/claude/2026-04/bbbbbbbb");
  });

  it("throws HandoffError when no candidates exist", async () => {
    // Override: ls-remote returns empty output → candidates = []
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    await expect(lib.pullRemote(null)).rejects.toThrow(HandoffError);
  });

  it("filters by fromCli when provided, returning only the matching CLI's branch", async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout:
        [
          "abc  refs/heads/handoff/proj/claude/2026-04/aaa",
          "def  refs/heads/handoff/proj/copilot/2026-04/bbb",
        ].join("\n") + "\n",
      stderr: "",
    });
    const result = await lib.pullRemote(null, "claude");
    expect(result.branch).toContain("claude");
  });

  it("throws HandoffError when fromCli filter yields no candidates", async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc  refs/heads/handoff/proj/copilot/2026-04/aaa\n",
      stderr: "",
    });
    await expect(lib.pullRemote(null, "claude")).rejects.toThrow(HandoffError);
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

  it("throws HandoffError when no candidates match the query after description enrichment", async () => {
    // Branch name and description both don't contain the query.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc  refs/heads/handoff/proj/claude/2026-04/abc12345\n",
      stderr: "",
    });
    mockFetchBranch("content", "handoff:v2:claude/abc/proj/host");
    await expect(lib.pullRemote("zzz-no-match")).rejects.toThrow(HandoffError);
  });

  it("exits 2 on non-TTY collision when multiple hits share the query", async () => {
    // Two branches both containing "abc" in the name.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout:
        [
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
      stdout:
        [
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
      stdout:
        [
          "aaa  refs/heads/handoff/proj/claude/2026-04/abc12345",
          "bbb  refs/heads/handoff/proj/claude/2026-04/abc67890",
        ].join("\n") + "\n",
      stderr: "",
    });
    mockFetchBranch("c1", "handoff:v2:claude/abc/proj/host");
    mockFetchBranch("c2", "handoff:v2:claude/abc/proj/host");

    createInterface.mockReturnValueOnce({
      question: (_prompt, cb) => cb("x"), // non-numeric → abort
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

// ---- fetchRemoteMetadata ----------------------------------------------

describe("fetchRemoteMetadata", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-probe");
  });

  it("parses metadata.json from a fetched branch", () => {
    // init, fetch, show — all succeed
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // fetch
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ session_id: "abc123", short_id: "abc12345" }),
      stderr: "",
    });
    const result = lib.fetchRemoteMetadata(
      "handoff/proj/claude/2026-04/aaaaaaaa",
      "https://example.test/repo.git",
    );
    expect(result.session_id).toBe("abc123");
  });

  it("throws when git init fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "disk full" });
    expect(() => lib.fetchRemoteMetadata("handoff/a/claude/2026-04/aaaaaaaa", "url")).toThrow(
      /git init failed/,
    );
  });

  it("throws when fetch fails", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "network error" });
    expect(() => lib.fetchRemoteMetadata("handoff/a/claude/2026-04/aaaaaaaa", "url")).toThrow(
      /fetch failed/,
    );
  });

  it("throws when metadata.json is missing (legacy branch)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 128,
      stdout: "",
      stderr: "fatal: path 'metadata.json' does not exist",
    });
    expect(() => lib.fetchRemoteMetadata("handoff/a/claude/2026-04/aaaaaaaa", "url")).toThrow(
      /metadata.json missing/,
    );
  });

  it("throws when metadata.json is malformed", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "not { valid json", stderr: "" });
    expect(() => lib.fetchRemoteMetadata("handoff/a/claude/2026-04/aaaaaaaa", "url")).toThrow(
      /parse failed/,
    );
  });
});

// ---- listPruneCandidates ------------------------------------------------

describe("listPruneCandidates", () => {
  const REPO = "git@example.test:me/store.git";
  let origRepo;
  beforeEach(() => {
    origRepo = process.env.DOTBABEL_HANDOFF_REPO;
    process.env.DOTBABEL_HANDOFF_REPO = REPO;
    spawnSync.mockReset();
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-prune");
  });
  afterEach(() => {
    if (origRepo === undefined) delete process.env.DOTBABEL_HANDOFF_REPO;
    else process.env.DOTBABEL_HANDOFF_REPO = origRepo;
  });

  // Drive the spawnSync mock through:
  //   1) ls-remote (listRemoteCandidates inventory)
  //   2) git init (withShallowFetch)
  //   3) git fetch (withShallowFetch)
  //   4) for-each-ref
  //   5..N) git show metadata.json — one per refspec
  function queueShallowFetch({ inventory, ferRows, metaPerBranch }) {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: inventory.map((b) => `0123456789abcdef\trefs/heads/${b}`).join("\n") + "\n",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: ferRows.join("\n") + "\n", stderr: "" });
    for (const m of metaPerBranch) {
      spawnSync.mockReturnValueOnce(m);
    }
  }

  it("returns empty when ls-remote is empty (no candidates, no fetch)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const r = lib.listPruneCandidates({ olderThanMs: Date.now(), repoUrl: REPO });
    expect(r.candidates).toEqual([]);
    expect(r.total).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("filters in branches older than cutoff and matching ownHost", async () => {
    const ownHost = (await import("node:os"))
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const olderThanMs = Date.now() - 1000;
    const oldBranch = "handoff/p/claude/2026-01/aaaaaaaa";
    queueShallowFetch({
      inventory: [oldBranch],
      ferRows: [`${oldBranch}|abcd1234|1700000000`],
      metaPerBranch: [
        {
          status: 0,
          stdout: JSON.stringify({ cli: "claude", hostname: ownHost, short_id: "aaaaaaaa" }),
          stderr: "",
        },
      ],
    });
    const r = lib.listPruneCandidates({ olderThanMs, repoUrl: REPO });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].branch).toBe(oldBranch);
    expect(r.candidates[0].commit).toBe("abcd1234");
    expect(r.candidates[0].hostname).toBe(ownHost);
  });

  it("buckets too-young branches as byAge", async () => {
    const ownHost = (await import("node:os"))
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const olderThanMs = 1000; // far in the past
    const young = "handoff/p/claude/2026-04/bbbbbbbb";
    queueShallowFetch({
      inventory: [young],
      ferRows: [`${young}|aaaa|9999999999`],
      // metadata.show would never run because age skip happens first
      metaPerBranch: [],
    });
    const r = lib.listPruneCandidates({ olderThanMs, repoUrl: REPO });
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.byAge).toBe(1);
  });

  it("buckets foreign-host branches as byHost", () => {
    const olderThanMs = Date.now() + 1000; // everything is "old"
    const branch = "handoff/p/claude/2026-01/cccccccc";
    queueShallowFetch({
      inventory: [branch],
      ferRows: [`${branch}|cccc|1700000000`],
      metaPerBranch: [
        {
          status: 0,
          stdout: JSON.stringify({ cli: "claude", hostname: "other-host" }),
          stderr: "",
        },
      ],
    });
    const r = lib.listPruneCandidates({ olderThanMs, repoUrl: REPO });
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.byHost).toBe(1);
  });

  it("buckets missing/unparseable metadata as byMissingMeta", () => {
    const olderThanMs = Date.now() + 1000;
    const a = "handoff/p/claude/2026-01/dddddddd";
    const b = "handoff/p/claude/2026-01/eeeeeeee";
    queueShallowFetch({
      inventory: [a, b],
      ferRows: [`${a}|aa|1700000000`, `${b}|bb|1700000000`],
      metaPerBranch: [
        { status: 128, stdout: "", stderr: "metadata.json missing" },
        { status: 0, stdout: "not { json", stderr: "" },
      ],
    });
    const r = lib.listPruneCandidates({ olderThanMs, repoUrl: REPO });
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.byMissingMeta).toBe(2);
  });

  it("buckets metadata-without-hostname as byMissingMeta (provable-ownership rule)", () => {
    const olderThanMs = Date.now() + 1000;
    const branch = "handoff/p/claude/2026-01/ffffffff";
    queueShallowFetch({
      inventory: [branch],
      ferRows: [`${branch}|ff|1700000000`],
      metaPerBranch: [{ status: 0, stdout: JSON.stringify({ cli: "claude" }), stderr: "" }],
    });
    const r = lib.listPruneCandidates({ olderThanMs, repoUrl: REPO });
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.byMissingMeta).toBe(1);
    expect(r.skipped.byHost).toBe(0);
  });

  it("applies fromCli filter and counts byFromCli", async () => {
    const ownHost = (await import("node:os"))
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const olderThanMs = Date.now() + 1000;
    const a = "handoff/p/claude/2026-01/11111111";
    const b = "handoff/p/codex/2026-01/22222222";
    queueShallowFetch({
      inventory: [a, b],
      ferRows: [`${a}|11|1700000000`, `${b}|22|1700000000`],
      metaPerBranch: [
        { status: 0, stdout: JSON.stringify({ cli: "claude", hostname: ownHost }), stderr: "" },
        { status: 0, stdout: JSON.stringify({ cli: "codex", hostname: ownHost }), stderr: "" },
      ],
    });
    const r = lib.listPruneCandidates({ olderThanMs, fromCli: "claude", repoUrl: REPO });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].cli).toBe("claude");
    expect(r.skipped.byFromCli).toBe(1);
  });
});

// ---- deleteRemoteBranches -----------------------------------------------

describe("deleteRemoteBranches", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-delete");
  });

  it("returns empty result for empty input without spawning git", () => {
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", []);
    expect(r).toEqual({ deleted: [], failures: [] });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("issues a single batched push --porcelain --delete and reports all branches deleted on success", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // push --delete
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", [
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.deleted).toEqual([
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.failures).toEqual([]);
    // The single push call carried both refs and used --porcelain.
    const pushCall = spawnSync.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("--delete"),
    );
    expect(pushCall[1]).toContain("--porcelain");
    expect(pushCall[1]).toContain("refs/heads/handoff/p/claude/2026-01/aaaaaaaa");
    expect(pushCall[1]).toContain("refs/heads/handoff/p/claude/2026-01/bbbbbbbb");
  });

  it("falls back to legacy all-failed report with redacted URLs when neither porcelain stdout nor stderr classify any ref (and parser-driven retry also fails)", () => {
    // git init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // batched push --delete: total auth failure, no per-ref status lines on stdout or stderr.
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fatal: unable to access 'https://user:tok@x.test/repo.git/': denied",
    });
    // per-ref retry: same auth error.
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fatal: unable to access 'https://user:tok@x.test/repo.git/': denied",
    });
    const r = lib.deleteRemoteBranches("https://user:tok@x.test/repo.git", [
      "handoff/p/claude/2026-01/aaaaaaaa",
    ]);
    expect(r.deleted).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].branch).toBe("handoff/p/claude/2026-01/aaaaaaaa");
    expect(r.failures[0].reason).not.toMatch(/user:tok/);
    expect(r.failures[0].reason).toMatch(/\*\*\*@/);
  });

  it("partitions partial-success porcelain stdout into deleted + rejected (issue #179 reproduction)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    const stdout = [
      "To github.com:owner/repo.git",
      "-\t:refs/heads/handoff/dotbabel/claude/2026-04/98d26b79\t[deleted]",
      "-\t:refs/heads/handoff/dotbabel/claude/2026-05/00837a18\t[deleted]",
      "-\t:refs/heads/handoff/squadranks/claude/2026-05/d6243fc6\t[deleted]",
      "!\t:refs/heads/handoff/dotbabel/claude/2026-04/3668f1d7\t[remote rejected] (refusing to delete the current branch: refs/heads/handoff/dotbabel/claude/2026-04/3668f1d7)",
      "Done",
    ].join("\n");
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout,
      stderr: "error: failed to push some refs to 'github.com:owner/repo.git'",
    });
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", [
      "handoff/dotbabel/claude/2026-04/3668f1d7",
      "handoff/dotbabel/claude/2026-04/98d26b79",
      "handoff/dotbabel/claude/2026-05/00837a18",
      "handoff/squadranks/claude/2026-05/d6243fc6",
    ]);
    expect(r.deleted.sort()).toEqual([
      "handoff/dotbabel/claude/2026-04/98d26b79",
      "handoff/dotbabel/claude/2026-05/00837a18",
      "handoff/squadranks/claude/2026-05/d6243fc6",
    ]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].branch).toBe("handoff/dotbabel/claude/2026-04/3668f1d7");
    expect(r.failures[0].reason).toMatch(/refusing to delete the current branch/);
  });

  it("falls back to stderr parsing when porcelain stdout is missing (older git)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    // No porcelain output (older git that ignores --porcelain), human stderr present.
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: [
        "To github.com:owner/repo.git",
        " - [deleted]         handoff/p/claude/2026-01/aaaaaaaa",
        " ! [remote rejected] handoff/p/claude/2026-01/bbbbbbbb (refusing to delete the current branch)",
        "error: failed to push some refs",
      ].join("\n"),
    });
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", [
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.deleted).toEqual(["handoff/p/claude/2026-01/aaaaaaaa"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].branch).toBe("handoff/p/claude/2026-01/bbbbbbbb");
    expect(r.failures[0].reason).toMatch(/refusing to delete the current branch/);
  });

  it("retries unparsed branches per-ref and merges the retry outcome", () => {
    // git init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // batched push: A classified as deleted via porcelain, B missing entirely.
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "-\t:refs/heads/handoff/p/claude/2026-01/aaaaaaaa\t[deleted]\n",
      stderr: "",
    });
    // per-ref retry for B succeeds.
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", [
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.deleted.sort()).toEqual([
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.failures).toEqual([]);
  });

  it("retries unparsed branches per-ref and reports a single-line reason on retry failure", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // init
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "-\t:refs/heads/handoff/p/claude/2026-01/aaaaaaaa\t[deleted]\n",
      stderr: "",
    });
    // Per-ref retry for B fails with a porcelain-shaped rejection.
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout:
        "!\t:refs/heads/handoff/p/claude/2026-01/bbbbbbbb\t[remote rejected] (pre-receive hook declined)\n",
      stderr: "error: failed to push some refs",
    });
    const r = lib.deleteRemoteBranches("https://x.test/repo.git", [
      "handoff/p/claude/2026-01/aaaaaaaa",
      "handoff/p/claude/2026-01/bbbbbbbb",
    ]);
    expect(r.deleted).toEqual(["handoff/p/claude/2026-01/aaaaaaaa"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].branch).toBe("handoff/p/claude/2026-01/bbbbbbbb");
    expect(r.failures[0].reason).toBe("pre-receive hook declined");
    // Reason must be single-line so the renderer cannot duplicate a multi-line block.
    expect(r.failures[0].reason).not.toMatch(/\n/);
  });

  it("throws when git init fails", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "disk full" });
    expect(() => lib.deleteRemoteBranches("url", ["handoff/x"])).toThrow(/git init failed/);
  });
});

describe("parsePushDeletePorcelain", () => {
  it("classifies tab-delimited per-ref status lines", () => {
    const stdout = [
      "To github.com:owner/repo.git",
      "-\t:refs/heads/handoff/x/claude/2026-01/aaaaaaaa\t[deleted]",
      "!\t:refs/heads/handoff/x/claude/2026-01/bbbbbbbb\t[remote rejected] (default branch protected)",
      "!\t:refs/heads/handoff/x/claude/2026-01/cccccccc\t[rejected] (non-fast-forward)",
      "!\t:refs/heads/handoff/x/claude/2026-01/dddddddd\t[error] (hook declined)",
      "Done",
    ].join("\n");
    const r = lib.parsePushDeletePorcelain(stdout, [
      "handoff/x/claude/2026-01/aaaaaaaa",
      "handoff/x/claude/2026-01/bbbbbbbb",
      "handoff/x/claude/2026-01/cccccccc",
      "handoff/x/claude/2026-01/dddddddd",
      "handoff/x/claude/2026-01/eeeeeeee",
    ]);
    expect(r.deleted).toEqual(["handoff/x/claude/2026-01/aaaaaaaa"]);
    expect(r.failures.map((f) => [f.branch, f.reason])).toEqual([
      ["handoff/x/claude/2026-01/bbbbbbbb", "default branch protected"],
      ["handoff/x/claude/2026-01/cccccccc", "non-fast-forward"],
      ["handoff/x/claude/2026-01/dddddddd", "hook declined"],
    ]);
    expect(r.unclassified).toEqual(["handoff/x/claude/2026-01/eeeeeeee"]);
  });

  it("returns all branches as unclassified for empty stdout", () => {
    const r = lib.parsePushDeletePorcelain("", ["handoff/x/claude/2026-01/aaaaaaaa"]);
    expect(r.deleted).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.unclassified).toEqual(["handoff/x/claude/2026-01/aaaaaaaa"]);
  });
});

describe("parsePushDeleteStderr", () => {
  it("classifies each line shape and reports unmatched branches as unclassified", () => {
    const stderr = [
      "To github.com:owner/repo.git",
      " - [deleted]         handoff/x/claude/2026-01/aaaaaaaa",
      " ! [remote rejected] handoff/x/claude/2026-01/bbbbbbbb (default branch protected)",
      " ! [rejected]        handoff/x/claude/2026-01/cccccccc (non-fast-forward)",
      " ! [error]           handoff/x/claude/2026-01/dddddddd (hook declined)",
    ].join("\n");
    const r = lib.parsePushDeleteStderr(stderr, [
      "handoff/x/claude/2026-01/aaaaaaaa",
      "handoff/x/claude/2026-01/bbbbbbbb",
      "handoff/x/claude/2026-01/cccccccc",
      "handoff/x/claude/2026-01/dddddddd",
      "handoff/x/claude/2026-01/eeeeeeee",
    ]);
    expect(r.deleted).toEqual(["handoff/x/claude/2026-01/aaaaaaaa"]);
    expect(r.failures.map((f) => [f.branch, f.reason])).toEqual([
      ["handoff/x/claude/2026-01/bbbbbbbb", "default branch protected"],
      ["handoff/x/claude/2026-01/cccccccc", "non-fast-forward"],
      ["handoff/x/claude/2026-01/dddddddd", "hook declined"],
    ]);
    expect(r.unclassified).toEqual(["handoff/x/claude/2026-01/eeeeeeee"]);
  });

  it("returns all branches as unclassified for empty stderr", () => {
    const r = lib.parsePushDeleteStderr("", ["handoff/x/claude/2026-01/aaaaaaaa"]);
    expect(r.deleted).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.unclassified).toEqual(["handoff/x/claude/2026-01/aaaaaaaa"]);
  });
});

// ---- seedTransportDefaultBranch ---------------------------------------

describe("seedTransportDefaultBranch", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-seed");
  });

  it("no-ops the seed when main already exists on the remote and PATCHes default to main", () => {
    // ls-remote: main exists.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abcdef0123456789abcdef0123456789abcdef01\trefs/heads/main\n",
      stderr: "",
    });
    // gh api PATCH: success.
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const r = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(r).toEqual({ seeded: false, defaultBranchPatched: true });
    // Two spawns total (no init/add/commit/push).
    expect(spawnSync).toHaveBeenCalledTimes(2);
    const cmds = spawnSync.mock.calls.map((c) => `${c[0]} ${c[1].slice(0, 2).join(" ")}`);
    expect(cmds[0]).toMatch(/^git ls-remote/);
    expect(cmds[1]).toMatch(/^gh api/);
  });

  it("seeds main via init/add/commit/push when ls-remote returns no refs, then PATCHes default", () => {
    // ls-remote: empty stdout.
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // git init -b main
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // git add README.md
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // git commit
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // git push
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    // gh api PATCH
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const r = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(r).toEqual({ seeded: true, defaultBranchPatched: true });
    const initCall = spawnSync.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("init"),
    );
    expect(initCall[1]).toContain("-b");
    expect(initCall[1]).toContain("main");
    const pushCall = spawnSync.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "push",
    );
    expect(pushCall[1]).toContain("git@github.com:alice/store.git");
    expect(pushCall[1]).toContain("main");
    const patchCall = spawnSync.mock.calls.find(
      (c) => c[0] === "gh" && Array.isArray(c[1]) && c[1].includes("PATCH"),
    );
    expect(patchCall[1]).toContain("repos/alice/store");
    expect(patchCall[1]).toContain("default_branch=main");
  });

  it("returns a warning instead of throwing when the gh PATCH fails", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abcdef0123456789abcdef0123456789abcdef01\trefs/heads/main\n",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "HTTP 403: Resource not accessible by integration",
    });
    const r = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(r.seeded).toBe(false);
    expect(r.defaultBranchPatched).toBe(false);
    expect(r.warning).toMatch(/could not set default branch to main/);
    expect(r.warning).toMatch(/repos\/alice\/store/);
  });

  it("throws when push of seeded main fails (cannot establish main on remote)", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // ls-remote empty
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git add
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git commit
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fatal: unable to access remote",
    });
    expect(() =>
      lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git"),
    ).toThrow(/git push.*main.*failed/);
  });

  it("treats ls-remote non-zero exit as 'no main' and seeds (covers probe.status !== 0 branch)", () => {
    // ls-remote: failed (e.g. transient transport error before HEAD probe).
    spawnSync.mockReturnValueOnce({ status: 128, stdout: "", stderr: "remote helper hiccup" });
    // Full seed sequence then PATCH success.
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git init
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git add
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git commit
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git push
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // gh PATCH
    const r = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(r).toEqual({ seeded: true, defaultBranchPatched: true });
  });

  it("falls back to stdout then to 'gh exited <status>' when PATCH stderr is empty", () => {
    // Case A: stderr empty, stdout has the message.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abcdef0123456789abcdef0123456789abcdef01\trefs/heads/main\n",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "could not change repo settings\n",
      stderr: "",
    });
    const a = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(a.warning).toMatch(/could not change repo settings/);

    // Case B: both empty — falls through to "gh exited <status>".
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abcdef0123456789abcdef0123456789abcdef01\trefs/heads/main\n",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 7, stdout: "", stderr: "" });
    const b = lib.seedTransportDefaultBranch("alice", "store", "git@github.com:alice/store.git");
    expect(b.warning).toMatch(/gh exited 7/);
  });
});

// ---- probeCollision ----------------------------------------------------

describe("probeCollision", () => {
  let exitSpy;
  let stderrSpy;
  beforeEach(() => {
    spawnSync.mockReset();
    mkdtempSync.mockReset().mockReturnValue("/tmp/mock-probe");
    exitSpy = mockExit();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("returns create when ls-remote stdout is empty", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A");
    expect(r).toEqual({ mode: "create" });
  });

  it("returns update when remote session_id matches local", () => {
    // ls-remote → branch present
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    // fetchRemoteMetadata: init, fetch, show
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ session_id: "sess-A" }),
      stderr: "",
    });
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A");
    expect(r).toEqual({ mode: "update" });
  });

  it("fails closed on session mismatch without force", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ session_id: "sess-OTHER" }),
      stderr: "",
    });
    expect(() => lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A")).toThrow(
      /__exit__2/,
    );
  });

  it("returns force on session mismatch with force=true and warns to stderr", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ session_id: "sess-OTHER" }),
      stderr: "",
    });
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A", {
      force: true,
    });
    expect(r).toEqual({ mode: "force" });
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("fails closed when ls-remote itself errors", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "auth denied" });
    expect(() => lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A")).toThrow(
      /__exit__2/,
    );
  });

  it("returns force when ls-remote errors and force=true", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "auth denied" });
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A", {
      force: true,
    });
    expect(r).toEqual({ mode: "force" });
  });

  it("redacts user:token@ from ls-remote stderr before echoing to the user", () => {
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr:
        "fatal: unable to access 'https://user:s3cr3t-token@github.com/x/y.git/': auth denied",
    });
    const r = lib.probeCollision(
      "https://user:s3cr3t-token@github.com/x/y.git",
      "handoff/a/claude/2026-04/aaaaaaaa",
      "sess-A",
      { force: true },
    );
    expect(r).toEqual({ mode: "force" });
    const warnText = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(warnText).not.toContain("s3cr3t-token");
    expect(warnText).toContain("https://***@github.com");
  });

  it("fails closed when remote metadata is missing (legacy branch)", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 128,
      stdout: "",
      stderr: "fatal: path 'metadata.json' does not exist",
    });
    expect(() => lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A")).toThrow(
      /__exit__2/,
    );
  });

  it("returns force when remote metadata is missing and force=true", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 128,
      stdout: "",
      stderr: "fatal: path 'metadata.json' does not exist",
    });
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A", {
      force: true,
    });
    expect(r).toEqual({ mode: "force" });
  });

  it("fails closed when localSessionId is null without force", () => {
    expect(() => lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", null)).toThrow(
      /__exit__2/,
    );
  });

  it("returns force mode with a warning when localSessionId is null and force=true", () => {
    const r = lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", null, { force: true });
    expect(r).toEqual({ mode: "force" });
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("treats non-string session_id in remote metadata as mismatch", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc refs/heads/handoff/a/claude/2026-04/aaaaaaaa",
      stderr: "",
    });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ session_id: null }),
      stderr: "",
    });
    expect(() => lib.probeCollision("url", "handoff/a/claude/2026-04/aaaaaaaa", "sess-A")).toThrow(
      /__exit__2/,
    );
  });
});
