import { describe, it, expect } from "vitest";
import { buildCriteriaMarker, renderEvidenceComment, postEvidenceComment, CRITERIA_MARKER_PREFIX } from "../src/criteria/comment.mjs";

const SHA = "a".repeat(40);

function samplePayload(overrides = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "3.4.0" },
    head_sha: SHA,
    pr: 42,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict: "pass",
    specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass", argv: ["node"], exit_code: 0, duration_ms: 10, timed_out: false, truncated: false, tests: [{ file: "t.mjs", name: "passes", found_in_file: true, confirmed_by: "output", result: "passed" }], output_sha256: "0".repeat(64) }] }],
    ...overrides,
  };
}

describe("buildCriteriaMarker", () => {
  it("matches the exact §5 marker text", () => {
    expect(buildCriteriaMarker(SHA)).toBe(`<!-- dotbabel-criteria verified-sha=${SHA} -->`);
  });

  it("throws on a non-sha value, never producing an unmatchable marker silently", () => {
    expect(() => buildCriteriaMarker("not-a-sha")).toThrow(/invalid sha/);
  });
});

describe("renderEvidenceComment", () => {
  it("puts the marker on line 1 and the base64url payload on line 2", () => {
    const payload = samplePayload();
    const body = renderEvidenceComment(payload, {});
    const lines = body.split("\n");
    expect(lines[0]).toBe(buildCriteriaMarker(SHA));
    expect(lines[1].startsWith("<!-- dotbabel-criteria-payload ")).toBe(true);
    const encoded = lines[1].slice("<!-- dotbabel-criteria-payload ".length, -" -->".length);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(payload);
  });

  it("renders one table row per criterion with a confirmed/total tests count", () => {
    const payload = samplePayload({
      specs: [
        {
          id: "example",
          criteria: [
            { id: "AC-1", status: "pass", duration_ms: 5, tests: [{ result: "passed" }, { result: "passed" }] },
            { id: "AC-2", status: "pending" },
          ],
        },
      ],
    });
    const body = renderEvidenceComment(payload, {});
    expect(body).toContain("| example | AC-1 | pass | 2/2 | 5ms |");
    expect(body).toContain("| example | AC-2 | pending | — | — |");
  });

  it("includes a details block with the redacted tail for a criterion that has one", () => {
    const payload = samplePayload();
    const body = renderEvidenceComment(payload, { "AC-1": "some redacted output" });
    expect(body).toContain("<details><summary>AC-1 output</summary>");
    expect(body).toContain("some redacted output");
    expect(body).toContain("</details>");
  });

  it("shrinks output tails, not the marker or payload line, to stay at or under 60000 characters", () => {
    const payload = samplePayload({
      specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass" }, { id: "AC-2", status: "pass" }] }],
    });
    const tails = { "AC-1": "x".repeat(40000), "AC-2": "y".repeat(40000) };
    const body = renderEvidenceComment(payload, tails);
    expect(body.length).toBeLessThanOrEqual(60000);
    // The marker and payload lines are never truncated — the payload line
    // alone must still contain the exact, complete, decodable payload.
    const lines = body.split("\n");
    expect(lines[0]).toBe(buildCriteriaMarker(SHA));
    const encoded = lines[1].slice("<!-- dotbabel-criteria-payload ".length, -" -->".length);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(payload);
  });
});

describe("postEvidenceComment", () => {
  function fakeDeps({ me = "tester", comments = [], minimized = [], posted = [] } = {}) {
    return {
      capture(cmd) {
        if (/^gh api user/.test(cmd)) return me;
        if (/comments --paginate$/.test(cmd)) return JSON.stringify(comments);
        if (/^gh api graphql/.test(cmd)) {
          minimized.push(cmd);
          return "{}";
        }
        throw new Error(`unexpected capture: ${cmd}`);
      },
      ghApiWithInput(cmd, payload) {
        posted.push({ cmd, payload });
      },
      log() {},
    };
  }

  it("posts the new comment", () => {
    const posted = [];
    const deps = fakeDeps({ posted });
    postEvidenceComment(deps, { repo: "o/r", pr: 1, body: "new body" });
    expect(posted).toHaveLength(1);
    expect(posted[0].payload).toEqual({ body: "new body" });
    expect(posted[0].cmd).toMatch(/--method POST repos\/o\/r\/issues\/1\/comments/);
  });

  it("minimizes only its own older evidence comments, never a foreign or unrelated one", () => {
    const minimized = [];
    const comments = [
      { user: { login: "tester" }, node_id: "MINE_OLD", body: `${CRITERIA_MARKER_PREFIX}${"b".repeat(40)} -->\nold` },
      { user: { login: "someone-else" }, node_id: "FOREIGN", body: `${CRITERIA_MARKER_PREFIX}${"c".repeat(40)} -->\nold` },
      { user: { login: "tester" }, node_id: "UNRELATED", body: "not an evidence comment" },
    ];
    const deps = fakeDeps({ me: "tester", comments, minimized });
    postEvidenceComment(deps, { repo: "o/r", pr: 1, body: "new body" });
    expect(minimized).toHaveLength(1);
    expect(minimized[0]).toContain("MINE_OLD");
    expect(minimized[0]).not.toContain("FOREIGN");
    expect(minimized[0]).not.toContain("UNRELATED");
  });

  it("never edits a comment — the mutation is minimizeComment, never PATCH", () => {
    const comments = [{ user: { login: "tester" }, node_id: "MINE_OLD", body: `${CRITERIA_MARKER_PREFIX}${"b".repeat(40)} -->\nold` }];
    const posted = [];
    const deps = fakeDeps({ comments, posted });
    postEvidenceComment(deps, { repo: "o/r", pr: 1, body: "new body" });
    expect(posted.every((p) => !/PATCH/.test(p.cmd))).toBe(true);
  });
});
