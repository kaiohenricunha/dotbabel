// Pins the public surface of handoff-remote.mjs — the shared transport
// library extracted from bin/dotbabel-handoff.mjs in #91 Gap 1. These
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
    "extractMirror",
    "extractPrompts",
    "extractTodos",
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
    "parsePushDeletePorcelain",
    "parsePushDeleteStderr",
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
    "seedTransportDefaultBranch",
    "selectPromptsForRender",
    "selectTurnsForRender",
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

  it("allows gemini as the cli segment", () => {
    expect(
      lib.v2BranchName({
        project: "dotbabel",
        cli: "gemini",
        month: "2026-05",
        shortId: "9999aaaa",
      }),
    ).toBe("handoff/dotbabel/gemini/2026-05/9999aaaa");
  });
});

describe("parseHandoffBranch", () => {
  it("parses gemini v2 and legacy v1 branch names", () => {
    expect(lib.parseHandoffBranch("handoff/dotbabel/gemini/2026-05/9999aaaa")).toEqual({
      version: 2,
      cli: "gemini",
      shortId: "9999aaaa",
      yearMonth: "2026-05",
    });
    expect(lib.parseHandoffBranch("handoff/gemini/9999aaaa")).toEqual({
      version: 1,
      cli: "gemini",
      shortId: "9999aaaa",
      yearMonth: "",
    });
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

  it("renders all prompts when below the 50-prompt cap (handoff-hardening 2026-05-08)", () => {
    const prompts = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const block = lib.renderHandoffBlock(meta, prompts, [], "claude");
    expect(block).toContain("1. p0");
    expect(block).toContain("15. p14");
    expect(block).toContain("**User prompts (full log, 15).**");
  });

  it("pins prompt 1 and caps the rest at 49 when prompts exceed 50", () => {
    const prompts = Array.from({ length: 75 }, (_, i) => `p${i}`);
    const block = lib.renderHandoffBlock(meta, prompts, [], "claude");
    // p0 is pinned at position 1, then the last 49 (p26..p74) follow.
    expect(block).toContain("1. p0");
    expect(block).toContain("**User prompts (capped: 50 of 75, prompt 1 pinned).**");
    expect(block).toContain("50. p74");
    // p1..p25 are dropped (the ring-buffer head).
    expect(block).not.toContain("\n2. p1\n");
    expect(block).not.toContain("p25");
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

  it("includes the first turn alongside last 3 when more than 4 turns exist", () => {
    const turns = Array.from({ length: 10 }, (_, i) => `turn${i}`);
    const block = lib.renderHandoffBlock(meta, [], turns, "claude");
    // first turn (turn0) + last 3 (turn7, turn8, turn9) — turn1..turn6 dropped.
    expect(block).toContain("turn0");
    expect(block).toContain("turn7");
    expect(block).toContain("turn8");
    expect(block).toContain("turn9");
    expect(block).not.toContain("turn3");
    expect(block).toContain("**Assistant turns (first + last 3 of 10).**");
  });

  it("prepends a state block when opts.stateBlock is provided (Approach A opt-in)", () => {
    const stateBlock = '<handoff-state version="1">\ngoals: []\n</handoff-state>';
    const block = lib.renderHandoffBlock(meta, ["hi"], ["yo"], "claude", { stateBlock });
    expect(block.startsWith("<handoff-state")).toBe(true);
    expect(block).toContain('<handoff origin="claude"');
    // State block precedes the mechanical block in source order.
    expect(block.indexOf("<handoff-state")).toBeLessThan(block.indexOf("<handoff "));
  });

  it("renders Tracked TODOs section when opts.todos is non-empty", () => {
    const todos = [
      { content: "GOAL-MIGRATE-AUTH", status: "in_progress", activeForm: "" },
      { content: "GOAL-ROTATE-KEYS", status: "pending", activeForm: "" },
    ];
    const block = lib.renderHandoffBlock(meta, ["p"], ["t"], "claude", { todos });
    expect(block).toContain("**Tracked TODOs.**");
    expect(block).toContain("[in_progress] GOAL-MIGRATE-AUTH");
    expect(block).toContain("[pending] GOAL-ROTATE-KEYS");
  });

  it("renders Codex agent_message mirror only for entries NOT in the rendered turn selection (regression: handoff-hardening 2026-05-08 risk #2)", () => {
    // 10 turns; turn 7 contains a critical decision that lives in the mirror.
    // First+last-3 selection = [turn0, turn7-DROPPED, turn8, turn9]; correct
    // dedupe must compare against THE RENDERED SELECTION, not the full extract.
    // An incorrect dedupe filters the mirror entry out because turn 7's content
    // *is* in the full turns array — the user-reported failure mode.
    const turns = Array.from({ length: 10 }, (_, i) => `turn${i} content`);
    const decisionInMidSessionTurn = turns[6]; // dropped by first+last-3
    const mirror = [decisionInMidSessionTurn, "turn0 content"]; // turn0 IS rendered → dedupe out
    const block = lib.renderHandoffBlock(meta, [], turns, "claude", { mirror });
    expect(block).toContain("**Codex agent message mirror (not duplicated above).**");
    // The mid-session decision (NOT rendered under first+last-3) surfaces.
    expect(block).toContain(decisionInMidSessionTurn);
    // turn0 IS rendered above, so the mirror entry for turn0 is filtered.
    const mirrorSectionIdx = block.indexOf("**Codex agent message mirror");
    const mirrorTail = block.slice(mirrorSectionIdx);
    expect(mirrorTail.match(/turn0 content/g)?.length ?? 0).toBe(0);
  });

  it("omits Codex mirror section when every entry is in the rendered turn selection", () => {
    const turns = ["a", "b", "c"]; // all 3 rendered (≤4)
    const mirror = ["a", "b"]; // both already rendered above
    const block = lib.renderHandoffBlock(meta, [], turns, "claude", { mirror });
    expect(block).not.toContain("**Codex agent message mirror");
  });
});

describe("selectPromptsForRender", () => {
  it("returns the full list when at or below the cap", () => {
    expect(lib.selectPromptsForRender([])).toEqual([]);
    expect(lib.selectPromptsForRender(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    const at = Array.from({ length: 50 }, (_, i) => `p${i}`);
    expect(lib.selectPromptsForRender(at)).toHaveLength(50);
  });
  it("pins prompt 0 and ring-buffers the last 49 when above 50", () => {
    const over = Array.from({ length: 75 }, (_, i) => `p${i}`);
    const sel = lib.selectPromptsForRender(over);
    expect(sel).toHaveLength(50);
    expect(sel[0]).toBe("p0");
    expect(sel[1]).toBe("p26");
    expect(sel[49]).toBe("p74");
  });
});

describe("selectTurnsForRender", () => {
  it("returns the full list when at or below 4 turns", () => {
    expect(lib.selectTurnsForRender([])).toEqual([]);
    expect(lib.selectTurnsForRender(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });
  it("returns first + last 3 when above 4 turns", () => {
    const turns = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(lib.selectTurnsForRender(turns)).toEqual(["a", "f", "g", "h"]);
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
    expect(out).toContain("DOTBABEL_HANDOFF_REPO");
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
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("returns the validated URL when env var is set", () => {
    process.env.DOTBABEL_HANDOFF_REPO = "https://github.com/x/y.git";
    expect(lib.requireTransportRepoStrict()).toBe("https://github.com/x/y.git");
  });

  it("throws HandoffError when DOTBABEL_HANDOFF_REPO is not set", () => {
    delete process.env.DOTBABEL_HANDOFF_REPO;
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
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  it("returns the validated URL without bootstrapping when env var is already set", async () => {
    process.env.DOTBABEL_HANDOFF_REPO = "git@github.com:x/y.git";
    const url = await lib.requireTransportRepo();
    expect(url).toBe("git@github.com:x/y.git");
  });

  it("calls bootstrapTransportRepo and exits 2 when env var is absent in a non-TTY context", async () => {
    delete process.env.DOTBABEL_HANDOFF_REPO;
    // bootstrapTransportRepo detects non-TTY (isTty() returns false in vitest), prints
    // a manual-setup block to stderr, then calls process.exit(2).
    await expect(lib.requireTransportRepo()).rejects.toThrow(/__exit__2/);
  });
});
