/**
 * P-B3 — the evidence comment as a round trip: what `comment.mjs` writes,
 * `evidence.mjs` must read back, and the merge gate judges only what it can
 * read. These tests pin the seam between producer and judge, which is the one
 * place a drift would be invisible (the command would keep posting, the gate
 * would keep refusing, and neither would look broken on its own).
 */
import { describe, it, expect } from "vitest";
import { buildCriteriaMarker, renderEvidenceComment, postEvidenceComment, CRITERIA_MARKER_PREFIX } from "../src/criteria/comment.mjs";
import { parseEvidenceComment, evidencePayloadProblem, payloadCoverage } from "../src/criteria/evidence.mjs";

const SHA = "a".repeat(40);

function payload(over = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "3.4.0" },
    head_sha: SHA,
    pr: 42,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict: "pass",
    specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass" }] }],
    ...over,
  };
}

describe("evidence comment round trip", () => {
  it("round-trips an evidence payload through the marker comment", () => {
    const p = payload();
    const parsed = parseEvidenceComment(renderEvidenceComment(p, {}));
    expect(parsed.state).toBe("ok");
    expect(parsed.sha).toBe(SHA);
    expect(parsed.payload).toEqual(p);
  });

  it("rejects a marker whose SHA is not 40 hexadecimal characters", () => {
    expect(() => buildCriteriaMarker("not-a-sha")).toThrow(/invalid sha/);
    // And the read side refuses it too, rather than trusting a hand-written line.
    expect(parseEvidenceComment(`${CRITERIA_MARKER_PREFIX}zzzz -->\n`).state).toBe("not-evidence");
  });

  it("keeps the rendered comment at or under 60000 characters by shrinking output tails first", () => {
    const many = payload({
      specs: [{ id: "example", criteria: ["AC-1", "AC-2", "AC-3"].map((id) => ({ id, status: "pass" })) }],
    });
    const tails = { example: { "AC-1": "x".repeat(40000), "AC-2": "y".repeat(40000), "AC-3": "z".repeat(40000) } };
    const body = renderEvidenceComment(many, tails);

    expect(body.length).toBeLessThanOrEqual(60000);
    // The payload line survives intact — shrinking touches tails only.
    const parsed = parseEvidenceComment(body);
    expect(parsed.state).toBe("ok");
    expect(parsed.payload).toEqual(many);
  });

  it("round-trips any generated payload and SHA through build and parse", () => {
    // Property-ish sweep over the shapes the command actually emits: varying
    // spec counts, criterion counts, verdicts, and whether `pr` is present.
    const verdicts = ["pass", "fail", "unconfirmed", "error"];
    for (let specCount = 0; specCount <= 3; specCount += 1) {
      for (let critCount = 0; critCount <= 3; critCount += 1) {
        const sha = specCount.toString(16).repeat(40).slice(0, 40);
        const p = payload({
          head_sha: sha,
          verdict: verdicts[(specCount + critCount) % verdicts.length],
          ...(critCount % 2 === 0 ? {} : { pr: undefined }),
          specs: Array.from({ length: specCount }, (_, s) => ({
            id: `spec-${s}`,
            criteria: Array.from({ length: critCount }, (_, c) => ({ id: `AC-${c + 1}`, status: "pass" })),
          })),
        });
        if (p.pr === undefined) delete p.pr;

        const parsed = parseEvidenceComment(renderEvidenceComment(p, {}));
        expect(parsed.state, `specs=${specCount} crits=${critCount}`).toBe("ok");
        expect(parsed.sha).toBe(sha);
        expect(parsed.payload).toEqual(p);
      }
    }
  });

  it("posts a new comment and minimizes older evidence comments as OUTDATED", () => {
    const calls = [];
    const older = {
      user: { login: "tester" },
      node_id: "MINE_OLD",
      body: `${CRITERIA_MARKER_PREFIX}${"b".repeat(40)} -->\nold`,
    };
    const deps = {
      capture(argv) {
        calls.push({ kind: "capture", argv });
        const joined = argv.join(" ");
        if (/^gh api user\b/.test(joined)) return "tester";
        if (/comments --paginate$/.test(joined)) return JSON.stringify([older]);
        if (/^gh api graphql\b/.test(joined)) return "{}";
        throw new Error(`unexpected: ${joined}`);
      },
      ghApiWithInput(argv, body) {
        calls.push({ kind: "post", argv, body });
      },
      log() {},
    };

    postEvidenceComment(deps, { repo: "o/r", pr: 1, body: renderEvidenceComment(payload(), {}) });

    const posts = calls.filter((c) => c.kind === "post");
    const minimize = calls.filter((c) => c.kind === "capture" && c.argv[2] === "graphql");
    expect(posts).toHaveLength(1);
    expect(minimize).toHaveLength(1);
    expect(minimize[0].argv.join(" ")).toMatch(/minimizeComment/);
    expect(minimize[0].argv.join(" ")).toMatch(/OUTDATED/);
    expect(minimize[0].argv).toContain("id=MINE_OLD");
    // OPS-4: the new comment is posted before older ones are hidden, so a
    // failed POST never leaves the PR with no visible evidence at all.
    expect(calls.indexOf(posts[0])).toBeLessThan(calls.indexOf(minimize[0]));
  });
});

describe("evidence payload validation", () => {
  it("accepts the payload the command emits", () => {
    expect(evidencePayloadProblem(payload())).toBeNull();
  });

  it.each([
    ["an unsupported schema_version", { schema_version: 2 }, /schema_version/],
    ["a missing verdict", { verdict: undefined }, /verdict/],
    ["a non-array specs", { specs: "nope" }, /specs/],
  ])("rejects %s", (_label, over, rx) => {
    const p = payload(over);
    // `in`, not `=== undefined`: a row that simply does not mention verdict
    // would otherwise have its verdict deleted too, and fail on the wrong rule.
    if ("verdict" in over) delete p.verdict;
    expect(evidencePayloadProblem(p)).toMatch(rx);
  });

  it("reports a criterion that carries no status", () => {
    expect(evidencePayloadProblem(payload({ specs: [{ id: "example", criteria: [{ id: "AC-1" }] }] }))).toMatch(/status/);
  });

  it("excludes pending criteria from coverage, because nothing ran for them", () => {
    const covered = payloadCoverage(
      payload({ specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass" }, { id: "AC-2", status: "pending" }] }] }),
    );
    expect([...covered.get("example")]).toEqual(["AC-1"]);
  });
});
