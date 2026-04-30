// Pins the public surface of handoff-remote.mjs — the shared transport
// library extracted from bin/dotclaude-handoff.mjs in #91 Gap 1. These
// tests are redundant with handoff-unit / handoff-url-validator /
// handoff-bootstrap (which go through the bin re-exports), but they
// lock the library *directly* so a future gap can't silently narrow or
// widen the API without tripping a test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as lib from "../src/lib/handoff-remote.mjs";

describe("export shape", () => {
  // Keep alphabetized so the diff is readable when exports change.
  const expectedExports = [
    "CONFIG_FILE",
    "V1_BRANCH_RE",
    "V2_BRANCH_RE",
    "bootstrapTransportRepo",
    "decodeDescription",
    "deleteRemoteBranches",
    "encodeDescription",
    "enrichWithDescriptions",
    "extractLines",
    "extractMeta",
    "extractPrompts",
    "extractTurns",
    "fetchRemoteBranch",
    "fetchRemoteMetadata",
    "HandoffError",
    "ghAuthenticated",
    "ghAvailable",
    "ghLogin",
    "isRepoMissingError",
    "isTty",
    "listPruneCandidates",
    "listRemoteCandidates",
    "loadPersistedEnv",
    "matchesQuery",
    "mechanicalSummary",
    "monthBucket",
    "nextStepFor",
    "PRUNE_SKIP_BUCKETS",
    "parseDuration",
    "parseHandoffBranch",
    "parseTagsFromDescription",
    "printManualSetupBlock",
    "probeCollision",
    "projectSlugFromCwd",
    "promptLine",
    "pullRemote",
    "pushRemote",
    "renderHandoffBlock",
    "requireTransportRepo",
    "requireTransportRepoStrict",
    "runGit",
    "runGitOrThrow",
    "runScript",
    "slugify",
    "slugifyRepoName",
    "tagsFromMeta",
    "v2BranchName",
    "validateTransportUrl",
  ];

  it("exposes every documented name", () => {
    for (const name of expectedExports) {
      expect(lib[name], `missing export: ${name}`).toBeDefined();
    }
  });

  it("does not leak extra names beyond the documented set", () => {
    const actual = Object.keys(lib).sort();
    const extra = actual.filter((k) => !expectedExports.includes(k));
    expect(extra).toEqual([]);
  });
});

describe("v2BranchName", () => {
  it("assembles handoff/<project>/<cli>/<month>/<shortId>", () => {
    expect(
      lib.v2BranchName({ project: "foo", cli: "claude", month: "2026-04", shortId: "abcd1234" }),
    ).toBe("handoff/foo/claude/2026-04/abcd1234");
  });

  it("slugifies the project segment", () => {
    expect(
      lib.v2BranchName({
        project: "My Project!",
        cli: "codex",
        month: "2026-04",
        shortId: "ff00aa11",
      }),
    ).toBe("handoff/my-project/codex/2026-04/ff00aa11");
  });
});

describe("monthBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns YYYY-MM for a valid ISO input", () => {
    expect(lib.monthBucket("2026-04-22T12:00:00Z")).toBe("2026-04");
  });

  it("falls back to the current month when given null", () => {
    expect(lib.monthBucket(null)).toBe("2026-04");
  });

  it("falls back to the current month when given a nonsense date", () => {
    expect(lib.monthBucket("not-a-date")).toBe("2026-04");
  });
});

describe("matchesQuery", () => {
  const c = {
    branch: "handoff/proj/claude/2026-04/abcd1234",
    description: "handoff:v2:claude/abcd1234/proj/host",
    commit: "0fba2e3d99",
  };

  it("matches by branch substring", () => {
    expect(lib.matchesQuery(c, "abcd1234")).toBe(true);
    expect(lib.matchesQuery(c, "proj")).toBe(true);
  });

  it("matches by commit prefix (startsWith)", () => {
    expect(lib.matchesQuery(c, "0fba")).toBe(true);
    expect(lib.matchesQuery(c, "2e3d")).toBe(false);
  });

  it("is case-insensitive across all three fields", () => {
    expect(lib.matchesQuery(c, "CLAUDE")).toBe(true);
    expect(lib.matchesQuery(c, "HOST")).toBe(true);
  });

  it("rejects unrelated input", () => {
    expect(lib.matchesQuery(c, "zzz")).toBe(false);
  });
});

describe("validateTransportUrl (accept/reject matrix)", () => {
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

  for (const [label, url] of [
    ["https", "https://github.com/x/y.git"],
    ["http", "http://ghe/x/y.git"],
    ["git@", "git@github.com:x/y.git"],
    ["ssh://", "ssh://git@host:22/x.git"],
    ["file://", "file:///tmp/bare.git"],
    ["absolute path", "/tmp/bare"],
  ]) {
    it(`accepts ${label}`, () => {
      expect(lib.validateTransportUrl(url)).toBe(url);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  }

  for (const [label, url] of [
    ["ext:: exec scheme", "ext::sh -c evil"],
    ["data:", "data:text/plain,x"],
    ["javascript:", "javascript:alert(1)"],
    ["relative path", "relative/path"],
    ["bare hostname", "github.com/x/y"],
  ]) {
    it(`rejects ${label}`, () => {
      expect(() => lib.validateTransportUrl(url)).toThrow(/__exit__2/);
    });
  }
});

describe("isRepoMissingError (phrasing union)", () => {
  it("matches GitHub's wording", () => {
    expect(lib.isRepoMissingError("ERROR: Repository not found.")).toBe(true);
    expect(lib.isRepoMissingError("remote: Not Found")).toBe(true);
  });

  it("matches GitLab's wording", () => {
    expect(lib.isRepoMissingError("The project you were looking for could not be found.")).toBe(
      true,
    );
  });

  it("matches raw SSH / git phrasings", () => {
    expect(lib.isRepoMissingError("Could not read from remote repository.")).toBe(true);
    expect(lib.isRepoMissingError("fatal: 'x' does not appear to be a git repository")).toBe(true);
    expect(lib.isRepoMissingError("Permission denied (publickey)")).toBe(true);
  });

  it("rejects unrelated errors so the retry branch doesn't fire on real bugs", () => {
    expect(lib.isRepoMissingError("error: failed to push some refs")).toBe(false);
    expect(lib.isRepoMissingError("")).toBe(false);
    expect(lib.isRepoMissingError(null)).toBe(false);
  });
});

describe("slugify / slugifyRepoName edge cases", () => {
  it("slugify collapses dash runs and trims edges", () => {
    expect(lib.slugify("  Foo !! Bar  ")).toBe("foo-bar");
    expect(lib.slugify("...")).toBe("adhoc");
    expect(lib.slugify("")).toBe("adhoc");
  });

  it("slugify caps at 40 chars", () => {
    expect(lib.slugify("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("slugifyRepoName caps at 100 chars and trims edges", () => {
    expect(lib.slugifyRepoName("  -Handoff-Store-  ")).toBe("handoff-store");
    expect(lib.slugifyRepoName("a".repeat(200)).length).toBeLessThanOrEqual(100);
  });

  it("slugifyRepoName returns empty string for null/undefined input", () => {
    expect(lib.slugifyRepoName(null)).toBe("");
    expect(lib.slugifyRepoName(undefined)).toBe("");
  });
});

describe("nextStepFor", () => {
  it("returns codex task-specification text", () => {
    expect(lib.nextStepFor("codex")).toContain("task specification");
  });
  it("returns copilot pick-up text", () => {
    expect(lib.nextStepFor("copilot")).toContain("pick up where");
  });
  it("returns default continue text for any other CLI", () => {
    expect(lib.nextStepFor("claude")).toContain("Continue from");
    expect(lib.nextStepFor("unknown")).toContain("Continue from");
  });
});

describe("mechanicalSummary", () => {
  it("uses placeholder text when both arrays are empty", () => {
    const s = lib.mechanicalSummary([], []);
    expect(s).toContain("(session contained no user prompts)");
    expect(s).toContain("(session contained no assistant turns)");
  });

  it("uses first prompt and last turn when both arrays are non-empty", () => {
    const s = lib.mechanicalSummary(["first", "second"], ["turn1", "turn2"]);
    expect(s).toContain("first");
    expect(s).toContain("turn2");
  });

  it("clips strings longer than 160 chars with an ellipsis", () => {
    const long = "a".repeat(300);
    const s = lib.mechanicalSummary([long], [long]);
    expect(s).toContain("…");
  });

  it("does not clip strings that are 160 chars or shorter", () => {
    const exact = "b".repeat(160);
    const s = lib.mechanicalSummary([exact], [exact]);
    expect(s).not.toContain("…");
  });
});

describe("renderHandoffBlock", () => {
  const meta = { cli: "claude", short_id: "abc12345", cwd: "/projects/foo" };
  const metaNull = { cli: "codex", short_id: null, cwd: null };

  it("produces opening and closing <handoff> tags", () => {
    const block = lib.renderHandoffBlock(meta, ["p"], ["t"], "codex");
    expect(block).toMatch(/^<handoff /);
    expect(block).toContain("</handoff>");
  });

  it("uses empty string fallbacks for null short_id and cwd", () => {
    const block = lib.renderHandoffBlock(metaNull, [], [], "claude");
    expect(block).toContain('session=""');
    expect(block).toContain('cwd=""');
  });

  it("renders the fallback when prompts are empty", () => {
    const block = lib.renderHandoffBlock(meta, [], [], "claude");
    expect(block).toContain("(session contained no user prompts)");
  });

  it("renders the fallback when turns are empty", () => {
    const block = lib.renderHandoffBlock(meta, [], [], "claude");
    expect(block).toContain("_(session contained no assistant turns)_");
  });

  it("renders prompts and turns when present", () => {
    const block = lib.renderHandoffBlock(meta, ["user prompt"], ["assistant turn"], "claude");
    expect(block).toContain("user prompt");
    expect(block).toContain("assistant turn");
  });

  it("caps prompts at the last 10 and numbers them 1..10", () => {
    const prompts = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const block = lib.renderHandoffBlock(meta, prompts, [], "claude");
    expect(block).toContain("10. p14");
    expect(block).not.toContain("11. ");
  });

  it("truncates prompts longer than 300 chars", () => {
    const long = "x".repeat(500);
    const block = lib.renderHandoffBlock(meta, [long], [], "claude");
    expect(block).toContain("…");
  });

  it("truncates turns longer than 400 chars", () => {
    const long = "y".repeat(600);
    const block = lib.renderHandoffBlock(meta, [], [long], "claude");
    expect(block).toContain("…");
  });
});

describe("isTty", () => {
  it("returns false in the vitest environment (no TTY)", () => {
    expect(lib.isTty()).toBe(false);
  });
});

describe("printManualSetupBlock", () => {
  it("writes a setup message containing the reason to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    lib.printManualSetupBlock("test-reason-xyz");
    const out = spy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("test-reason-xyz");
    expect(out).toContain("DOTCLAUDE_HANDOFF_REPO");
    spy.mockRestore();
  });
});

describe("requireTransportRepoStrict", () => {
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
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("returns the validated URL when env var is set", () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "https://github.com/x/y.git";
    expect(lib.requireTransportRepoStrict()).toBe("https://github.com/x/y.git");
  });

  it("throws HandoffError when DOTCLAUDE_HANDOFF_REPO is not set", () => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    expect(() => lib.requireTransportRepoStrict()).toThrow(lib.HandoffError);
  });
});

describe("requireTransportRepo (env-var-set fast path)", () => {
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
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
  });

  it("returns the validated URL without bootstrapping when env var is already set", async () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "git@github.com:x/y.git";
    const url = await lib.requireTransportRepo();
    expect(url).toBe("git@github.com:x/y.git");
  });

  it("calls bootstrapTransportRepo and exits 2 when env var is absent in a non-TTY context", async () => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    // bootstrapTransportRepo detects non-TTY (isTty() returns false in vitest), prints
    // a manual-setup block to stderr, then calls process.exit(2).
    await expect(lib.requireTransportRepo()).rejects.toThrow(/__exit__2/);
  });
});
