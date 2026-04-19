// Pure-function unit tests for dotclaude-handoff internals.
// Covers: UUID_HEAD_RE, cliFromPath, projectSlugFromCwd, matchesQuery,
// nextStepFor, mechanicalSummary, CLI_LAYOUTS.

import { describe, it, expect } from "vitest";
import {
  UUID_HEAD_RE,
  CLI_LAYOUTS,
  cliFromPath,
  projectSlugFromCwd,
  matchesQuery,
  nextStepFor,
  mechanicalSummary,
} from "../bin/dotclaude-handoff.mjs";

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

  it("only collapses to 'adhoc' when normalisation leaves an empty string", () => {
    // Documented edge: "..." normalises to "-", which is non-empty so the
    // `|| "adhoc"` fallback does NOT fire. Locked in so a regex tweak that
    // silently changes this behaviour is surfaced by the suite.
    expect(projectSlugFromCwd("/root/...")).toBe("-");
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
    expect(s).toContain("(no user prompts captured)");
    expect(s).toContain("(no assistant turns captured)");
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
    for (const cli of ["claude", "copilot", "codex"]) {
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
});
