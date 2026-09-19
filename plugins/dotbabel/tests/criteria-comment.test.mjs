import { describe, it, expect } from "vitest";
import { buildCriteriaMarker, renderEvidenceComment, postEvidenceComment, CRITERIA_MARKER_PREFIX } from "../src/criteria/comment.mjs";

const SHA = "a".repeat(40);
const PAYLOAD_PREFIX = "<!-- dotbabel-criteria-payload ";

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

function decodePayloadLine(line) {
  return JSON.parse(Buffer.from(line.slice(PAYLOAD_PREFIX.length, -" -->".length), "base64url").toString("utf8"));
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
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
    expect(lines[1].startsWith(PAYLOAD_PREFIX)).toBe(true);
    expect(decodePayloadLine(lines[1])).toEqual(payload);
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

  it("includes a fenced details block with the redacted tail for a criterion that has one", () => {
    const body = renderEvidenceComment(samplePayload(), { example: { "AC-1": "some redacted output" } });
    expect(body).toContain("<details><summary>example AC-1 output</summary>");
    expect(body).toContain("```\nsome redacted output\n```");
    expect(body).toContain("</details>");
  });

  it("keeps the output tails of two specs that share a criterion id separate", () => {
    const payload = samplePayload({
      specs: [
        { id: "spec-a", criteria: [{ id: "AC-1", status: "pass" }] },
        { id: "spec-b", criteria: [{ id: "AC-1", status: "pass" }] },
      ],
    });
    const body = renderEvidenceComment(payload, { "spec-a": { "AC-1": "output from a" }, "spec-b": { "AC-1": "output from b" } });
    expect(body).toContain("<details><summary>spec-a AC-1 output</summary>");
    expect(body).toContain("output from a");
    expect(body).toContain("<details><summary>spec-b AC-1 output</summary>");
    expect(body).toContain("output from b");
  });

  it("fences output so it cannot close the details block early", () => {
    const tail = "</details>\n| example | AC-9 | pass | 1/1 | 1ms |";
    const body = renderEvidenceComment(samplePayload(), { example: { "AC-1": tail } });
    const fenceStart = body.indexOf(`\`\`\`\n${tail}\n\`\`\``);
    expect(fenceStart).toBeGreaterThan(-1);
    const fenceEnd = fenceStart + `\`\`\`\n${tail}\n\`\`\``.length;
    expect(body.lastIndexOf("</details>")).toBeGreaterThanOrEqual(fenceEnd);
  });

  it("uses a fence longer than any backtick run inside the output", () => {
    const body = renderEvidenceComment(samplePayload(), { example: { "AC-1": "before ```` after" } });
    expect(body).toContain("`````\nbefore ```` after\n`````");
  });

  it("escapes spec text taken from spec.json in table cells and summaries", () => {
    const payload = samplePayload({ specs: [{ id: "ex|<b>", criteria: [{ id: "AC-1", status: "pass" }] }] });
    const body = renderEvidenceComment(payload, { "ex|<b>": { "AC-1": "x" } });
    expect(body).toContain("| ex\\|&lt;b&gt; | AC-1 | pass |");
    expect(body).toContain("<summary>ex\\|&lt;b&gt; AC-1 output</summary>");
  });

  it("escapes backslashes before table pipes", () => {
    const payload = samplePayload({ specs: [{ id: "ex\\|fake", criteria: [{ id: "AC-1", status: "pass" }] }] });
    const body = renderEvidenceComment(payload, {});
    expect(body).toContain("| ex\\\\\\|fake | AC-1 | pass |");
  });

  it("shrinks output tails, not the marker or payload line, to stay at or under 60000 characters", () => {
    const payload = samplePayload({
      specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass" }, { id: "AC-2", status: "pass" }] }],
    });
    const tails = { example: { "AC-1": "x".repeat(40000), "AC-2": "y".repeat(40000) } };
    const body = renderEvidenceComment(payload, tails);
    expect(body.length).toBeLessThanOrEqual(60000);
    // The marker and payload lines are never truncated — the payload line
    // alone must still contain the exact, complete, decodable payload.
    const lines = body.split("\n");
    expect(lines[0]).toBe(buildCriteriaMarker(SHA));
    expect(decodePayloadLine(lines[1])).toEqual(payload);
  });

  it("shrinks tails of different lengths so that no over-budget tail stays whole and no block is cut", () => {
    const payload = samplePayload({ specs: [{ id: "example", criteria: ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => ({ id, status: "pass" })) }] });
    const tails = { example: { "AC-1": "s".repeat(50), "AC-2": "x".repeat(30000), "AC-3": "y".repeat(30000), "AC-4": "z".repeat(30000) } };
    const body = renderEvidenceComment(payload, tails);
    expect(body.length).toBeLessThanOrEqual(60000);
    expect(body).toContain("s".repeat(50));
    for (const ch of ["x", "y", "z"]) expect(body).not.toContain(ch.repeat(30000));
    expect(count(body, "<details>")).toBe(4);
    expect(count(body, "</details>")).toBe(4);
    expect(decodePayloadLine(body.split("\n")[1])).toEqual(payload);
  });

  it("drops details and then table rows before it would ever cut the marker or payload line", () => {
    const specId = "s".repeat(200);
    const criteria = Array.from({ length: 300 }, (_, i) => ({ id: `AC-${i + 1}`, status: "pass" }));
    const payload = samplePayload({ specs: [{ id: specId, criteria }] });
    const body = renderEvidenceComment(payload, { [specId]: { "AC-1": "tail" } });
    expect(body.length).toBeLessThanOrEqual(60000);
    const lines = body.split("\n");
    expect(lines[0]).toBe(buildCriteriaMarker(SHA));
    expect(decodePayloadLine(lines[1])).toEqual(payload);
    expect(body).toMatch(/more criteria not shown/);
    expect(count(body, "<details>")).toBe(count(body, "</details>"));
  });

  it("refuses to render when the marker and payload lines alone exceed the comment limit", () => {
    const criteria = Array.from({ length: 3000 }, (_, i) => ({ id: `AC-${i + 1}`, status: "error", error_message: "e".repeat(20) }));
    expect(() => renderEvidenceComment(samplePayload({ specs: [{ id: "example", criteria }] }), {})).toThrow(/exceeds/);
  });
});

describe("postEvidenceComment", () => {
  function fakeDeps({ me = "tester", comments = [], calls = [] } = {}) {
    return {
      capture(argv) {
        calls.push({ kind: "capture", argv });
        if (!Array.isArray(argv)) throw new Error(`expected an argument array, got ${JSON.stringify(argv)}`);
        const joined = argv.join(" ");
        if (/^gh api user\b/.test(joined)) return me;
        if (/comments --paginate$/.test(joined)) return typeof comments === "string" ? comments : JSON.stringify(comments);
        if (/^gh api graphql\b/.test(joined)) return "{}";
        throw new Error(`unexpected capture: ${joined}`);
      },
      ghApiWithInput(argv, payload) {
        calls.push({ kind: "post", argv, payload });
      },
      log() {},
    };
  }

  const minimizeCalls = (calls) => calls.filter((c) => c.kind === "capture" && c.argv[2] === "graphql");
  const postCalls = (calls) => calls.filter((c) => c.kind === "post");
  const olderMine = { user: { login: "tester" }, node_id: "MINE_OLD", body: `${CRITERIA_MARKER_PREFIX}${"b".repeat(40)} -->\nold` };

  it("posts the new comment", () => {
    const calls = [];
    postEvidenceComment(fakeDeps({ calls }), { repo: "o/r", pr: 1, body: "new body" });
    expect(postCalls(calls)).toHaveLength(1);
    expect(postCalls(calls)[0].payload).toEqual({ body: "new body" });
    expect(postCalls(calls)[0].argv.join(" ")).toMatch(/--method POST repos\/o\/r\/issues\/1\/comments/);
  });

  it("minimizes only the family named by markerPrefix, so one family never hides another", () => {
    const calls = [];
    const REVIEW_PREFIX = "<!-- review-complete verified-sha=";
    const comments = [
      olderMine,
      { user: { login: "tester" }, node_id: "REVIEW_OLD", body: `${REVIEW_PREFIX}${"b".repeat(40)} -->\nold` },
    ];
    postEvidenceComment(fakeDeps({ me: "tester", comments, calls }), {
      repo: "o/r",
      pr: 1,
      body: "new body",
      markerPrefix: REVIEW_PREFIX,
    });
    const minimized = minimizeCalls(calls);
    expect(minimized).toHaveLength(1);
    expect(minimized[0].argv).toContain("id=REVIEW_OLD");
  });

  it("minimizes only its own older evidence comments, never a foreign or unrelated one", () => {
    const calls = [];
    const comments = [
      olderMine,
      { user: { login: "someone-else" }, node_id: "FOREIGN", body: `${CRITERIA_MARKER_PREFIX}${"c".repeat(40)} -->\nold` },
      { user: { login: "tester" }, node_id: "UNRELATED", body: "not an evidence comment" },
    ];
    postEvidenceComment(fakeDeps({ me: "tester", comments, calls }), { repo: "o/r", pr: 1, body: "new body" });
    const minimized = minimizeCalls(calls);
    expect(minimized).toHaveLength(1);
    expect(minimized[0].argv).toContain("id=MINE_OLD");
  });

  it("never edits a comment — the mutation is minimizeComment, never PATCH", () => {
    const calls = [];
    postEvidenceComment(fakeDeps({ comments: [olderMine], calls }), { repo: "o/r", pr: 1, body: "new body" });
    expect(postCalls(calls).every((c) => !c.argv.includes("PATCH"))).toBe(true);
    expect(minimizeCalls(calls)[0].argv.join(" ")).toMatch(/minimizeComment/);
  });

  it("posts the new comment before it minimizes older ones", () => {
    const calls = [];
    postEvidenceComment(fakeDeps({ comments: [olderMine], calls }), { repo: "o/r", pr: 1, body: "new body" });
    const postIndex = calls.findIndex((c) => c.kind === "post");
    const minimizeIndex = calls.findIndex((c) => c.kind === "capture" && c.argv[2] === "graphql");
    expect(postIndex).toBeGreaterThan(-1);
    expect(minimizeIndex).toBeGreaterThan(postIndex);
  });

  it("passes the comment node id as a GraphQL variable, not inside the query text", () => {
    const calls = [];
    postEvidenceComment(fakeDeps({ comments: [olderMine], calls }), { repo: "o/r", pr: 1, body: "new body" });
    const argv = minimizeCalls(calls)[0].argv;
    const query = argv.find((arg) => arg.startsWith("query="));
    expect(query).toBeDefined();
    expect(query).not.toContain("MINE_OLD");
    expect(argv).toContain("id=MINE_OLD");
  });

  it("treats empty comment output as no older comments", () => {
    const calls = [];
    postEvidenceComment(fakeDeps({ comments: "", calls }), { repo: "o/r", pr: 1, body: "new body" });
    expect(minimizeCalls(calls)).toHaveLength(0);
    expect(postCalls(calls)).toHaveLength(1);
  });
});
