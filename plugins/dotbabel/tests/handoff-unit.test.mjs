// Pure-function unit tests for dotbabel-handoff internals.
// Covers: UUID_HEAD_RE, cliFromPath, projectSlugFromCwd, matchesQuery,
// nextStepFor, mechanicalSummary, CLI_LAYOUTS, detectHost.

import { describe, it, expect } from "vitest";
import {
  UUID_HEAD_RE,
  CLI_LAYOUTS,
  cliFromPath,
  detectHost,
  projectSlugFromCwd,
  matchesQuery,
  nextStepFor,
  mechanicalSummary,
} from "../bin/dotbabel-handoff.mjs";

describe("UUID_HEAD_RE", () => {
  it("captures the first 8 hex of a UUID embedded in a path", () => {
    const m = "/root/rollout-2026-04-18T10-00-00-abcd1234-5678-90ab-cdef-112233445566.jsonl"
      .match(UUID_HEAD_RE);
    expect(m?.[1]).toBe("abcd1234");
  });

  it("returns null for strings without a UUID", () => {
    expect("no uuid here".match(UUID_HEAD_RE)).toBeNull();
  });

  it("captures the first UUID when multiple appear", () => {
    const m = "aaaa1111-1111-1111-1111-111111111111 / bbbb2222-2222-2222-2222-222222222222"
      .match(UUID_HEAD_RE);
    expect(m?.[1]).toBe("aaaa1111");
  });
});

describe("cliFromPath", () => {
  it("recognises claude paths", () => {
    expect(cliFromPath("/home/u/.claude/projects/foo/abc.jsonl")).toBe("claude");
  });

  it("recognises copilot paths", () => {
    expect(cliFromPath("/home/u/.copilot/session-state/abc/events.jsonl")).toBe("copilot");
  });

  it("recognises codex paths", () => {
    expect(cliFromPath("/home/u/.codex/sessions/2026/04/18/rollout-x.jsonl")).toBe("codex");
  });

  it("recognises gemini paths", () => {
    expect(
      cliFromPath("/home/u/.gemini/tmp/proj/chats/session-2026-05-06T14-11-9999aaaa.jsonl"),
    ).toBe("gemini");
  });

  it("falls back to claude for unrecognised paths (documented default)", () => {
    // The function returns "claude" for anything it can't identify. Locked in
    // here so a future refactor does not silently change the default.
    expect(cliFromPath("/tmp/random.jsonl")).toBe("claude");
  });
});

describe("projectSlugFromCwd", () => {
  it("returns 'adhoc' for empty / missing cwd", () => {
    expect(projectSlugFromCwd("")).toBe("adhoc");
    expect(projectSlugFromCwd(undefined)).toBe("adhoc");
    expect(projectSlugFromCwd(null)).toBe("adhoc");
  });

  it("takes the last path segment", () => {
    expect(projectSlugFromCwd("/home/user/projects/my-app")).toBe("my-app");
  });

  it("ignores trailing slashes", () => {
    expect(projectSlugFromCwd("/home/user/projects/my-app/")).toBe("my-app");
  });

  it("normalises to lowercase and replaces special characters", () => {
    expect(projectSlugFromCwd("/root/My Project.v2")).toBe("my-project-v2");
  });

  it("caps the slug at 40 characters", () => {
    const long = "/root/" + "a".repeat(80);
    expect(projectSlugFromCwd(long).length).toBeLessThanOrEqual(40);
  });

  it("collapses to 'adhoc' when normalisation leaves only dashes", () => {
    // v0.10.0 aligned the JS slugify with the shell slugify — collapse
    // runs of '-' and trim leading / trailing '-'. "..." now reduces
    // to "" after trimming, and the `|| "adhoc"` fallback fires.
    expect(projectSlugFromCwd("/root/...")).toBe("adhoc");
  });
});

describe("matchesQuery", () => {
  const candidate = {
    branch: "handoffs/claude/abc12345",
    description: "claude/abc12345/my-app/laptop",
    commit: "1a2b3c4d5e",
  };

  it("matches by branch substring", () => {
    expect(matchesQuery(candidate, "abc12345")).toBe(true);
  });

  it("matches by description substring", () => {
    expect(matchesQuery(candidate, "my-app")).toBe(true);
  });

  it("matches by commit prefix (startsWith)", () => {
    expect(matchesQuery(candidate, "1a2b")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesQuery(candidate, "CLAUDE")).toBe(true);
    expect(matchesQuery(candidate, "MY-APP")).toBe(true);
  });

  it("does not match unrelated strings", () => {
    expect(matchesQuery(candidate, "zzz-not-present")).toBe(false);
  });

  it("handles missing optional fields without throwing", () => {
    const minimal = { branch: "handoffs/claude/x" };
    expect(matchesQuery(minimal, "claude")).toBe(true);
    expect(matchesQuery(minimal, "nope")).toBe(false);
  });
});

describe("nextStepFor", () => {
  it("emits claude-flavoured guidance by default", () => {
    expect(nextStepFor("claude")).toContain("assistant turn");
  });

  it("emits codex-flavoured guidance", () => {
    expect(nextStepFor("codex")).toContain("task specification");
  });

  it("emits copilot-flavoured guidance", () => {
    expect(nextStepFor("copilot")).toContain("pick up where");
  });

  it("falls back to the claude string for unknown targets", () => {
    // Locks in the default-claude fallback so a new CLI never silently
    // inherits generic prose instead of a tailored prompt.
    expect(nextStepFor("gibberish")).toBe(nextStepFor("claude"));
  });
});

describe("mechanicalSummary", () => {
  it("handles empty prompts and turns", () => {
    const s = mechanicalSummary([], []);
    expect(s).toContain("(session contained no user prompts)");
    expect(s).toContain("(session contained no assistant turns)");
  });

  it("quotes the first prompt and the last turn", () => {
    const s = mechanicalSummary(
      ["first prompt", "second prompt"],
      ["turn 1", "turn 2", "final turn"]
    );
    expect(s).toContain('"first prompt"');
    expect(s).toContain('"final turn"');
  });

  it("truncates long prompts with an ellipsis", () => {
    const long = "x".repeat(200);
    const s = mechanicalSummary([long], ["ok"]);
    expect(s).toMatch(/…/);
    expect(s).not.toContain(long);
  });
});

describe("CLI_LAYOUTS", () => {
  it("exposes root/walk/match triples for each CLI", () => {
    for (const cli of ["claude", "copilot", "codex", "gemini"]) {
      expect(CLI_LAYOUTS[cli]).toBeDefined();
      expect(typeof CLI_LAYOUTS[cli].root).toBe("function");
      expect(typeof CLI_LAYOUTS[cli].walk).toBe("number");
      expect(typeof CLI_LAYOUTS[cli].match).toBe("function");
    }
  });

  it("claude.root joins HOME with .claude/projects", () => {
    expect(CLI_LAYOUTS.claude.root("/h")).toBe("/h/.claude/projects");
  });

  it("copilot.match requires the filename to be events.jsonl", () => {
    expect(CLI_LAYOUTS.copilot.match("events.jsonl")).toBe(true);
    expect(CLI_LAYOUTS.copilot.match("other.jsonl")).toBe(false);
  });

  it("codex.match requires rollout-*.jsonl", () => {
    expect(CLI_LAYOUTS.codex.match("rollout-2026-04-18-abc.jsonl")).toBe(true);
    expect(CLI_LAYOUTS.codex.match("events.jsonl")).toBe(false);
    expect(CLI_LAYOUTS.codex.match("rollout.json")).toBe(false);
  });

  it("gemini.match requires session-*.jsonl", () => {
    expect(CLI_LAYOUTS.gemini.root("/h")).toBe("/h/.gemini/tmp");
    expect(CLI_LAYOUTS.gemini.match("session-2026-05-06T14-11-9999aaaa.jsonl")).toBe(true);
    expect(CLI_LAYOUTS.gemini.match("logs.json")).toBe(false);
    expect(CLI_LAYOUTS.gemini.match("checkpoint-test.json")).toBe(false);
  });
});

describe("detectHost", () => {
  it("returns 'unknown' on empty env", () => {
    expect(detectHost({})).toBe("unknown");
  });

  it("returns 'claude' when CLAUDECODE=1", () => {
    expect(detectHost({ CLAUDECODE: "1" })).toBe("claude");
  });

  it("treats CLAUDECODE values other than '1' as unset", () => {
    // Locks in the strict-equals check: a future loosening that lets
    // CLAUDECODE=0 or empty-string return "claude" would silently
    // mislabel hosts that explicitly opt out.
    expect(detectHost({ CLAUDECODE: "0" })).toBe("unknown");
    expect(detectHost({ CLAUDECODE: "" })).toBe("unknown");
  });

  it("returns 'claude' on CLAUDE_CODE_SSE_PORT fallback when CLAUDECODE is unset", () => {
    expect(detectHost({ CLAUDE_CODE_SSE_PORT: "12345" })).toBe("claude");
  });

  it("returns 'codex' on any CODEX_* prefix", () => {
    expect(detectHost({ CODEX_HOME: "/tmp/codex" })).toBe("codex");
    expect(detectHost({ CODEX_SESSION_ID: "abc" })).toBe("codex");
  });

  it("returns 'copilot' on GITHUB_COPILOT_* or COPILOT_* prefix", () => {
    expect(detectHost({ GITHUB_COPILOT_CLI: "1" })).toBe("copilot");
    expect(detectHost({ COPILOT_SESSION: "1" })).toBe("copilot");
  });

  it("returns 'gemini' on GEMINI_CLI signals", () => {
    expect(detectHost({ GEMINI_CLI: "1" })).toBe("gemini");
    expect(detectHost({ GEMINI_CLI_SESSION: "1" })).toBe("gemini");
  });

  it("prioritises claude > codex > copilot > gemini when multiple signals fire", () => {
    // Probe order is load-bearing: it determines which host "wins"
    // when an operator has env vars for multiple CLIs exported.
    expect(
      detectHost({
        CLAUDECODE: "1",
        CODEX_HOME: "/x",
        COPILOT_SESSION: "1",
        GEMINI_CLI: "1",
      }),
    ).toBe("claude");
    expect(detectHost({ CODEX_HOME: "/x", COPILOT_SESSION: "1", GEMINI_CLI: "1" })).toBe("codex");
    expect(detectHost({ COPILOT_SESSION: "1", GEMINI_CLI: "1" })).toBe("copilot");
  });

  it("does not match unrelated env vars starting with CLAUDE", () => {
    // Guards against a future refactor that replaces the strict probes
    // with a prefix scan — only CLAUDECODE / CLAUDE_CODE_SSE_PORT count.
    expect(detectHost({ CLAUDE_TEST_FOO: "1" })).toBe("unknown");
  });

  it("requires the trailing underscore on CODEX_ and COPILOT_ probes", () => {
    // The prefix scans are `startsWith("CODEX_")` / `startsWith("COPILOT_")`
    // on purpose: a future loosening to bare "CODEX" would match e.g.
    // CODEX (no underscore) or CODEXHOME and mis-label unrelated tooling.
    expect(detectHost({ CODEX: "1" })).toBe("unknown");
    expect(detectHost({ CODEXHOME: "/tmp" })).toBe("unknown");
    expect(detectHost({ COPILOT: "1" })).toBe("unknown");
    expect(detectHost({ GEMINI: "1" })).toBe("unknown");
  });
});
