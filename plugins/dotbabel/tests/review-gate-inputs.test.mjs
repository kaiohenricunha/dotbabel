import { describe, it, expect } from "vitest";

import {
  commitIsAncestor,
  prReviewThreads,
  prReviews,
  reviewEntryFacts,
} from "../src/review-gate-inputs.mjs";
import { buildAttestationPayload, renderAttestationHeader } from "../src/attestation.mjs";
import { buildReviewPayload, renderReviewComment } from "../src/review-evidence.mjs";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const OTHER = "c".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");

/** A deps.run stub answering one canned response per call, in order, and recording argv. */
function stub(...replies) {
  const calls = [];
  return {
    calls,
    run(argv) {
      calls.push(argv);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return typeof r === "function" ? r(argv) : r;
    },
  };
}
const ok = (data) => ({ status: 0, stdout: JSON.stringify(data), stderr: "" });
const page = (field, nodes, next = null) =>
  ok({
    data: { repository: { pullRequest: { [field]: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } },
  });

describe("prReviews", () => {
  it("maps each review to the fields the receipt check reads", () => {
    const deps = stub(
      page("reviews", [
        { body: "b1", authorAssociation: "OWNER", lastEditedAt: null, commit: { oid: REVIEWED } },
        { body: "b2", authorAssociation: "NONE", lastEditedAt: "2026-01-02T00:00:00Z", commit: null },
        { authorAssociation: "MEMBER" },
      ]),
    );
    expect(prReviews(deps, 7)).toEqual([
      { body: "b1", authorAssociation: "OWNER", lastEditedAt: null, commitOid: REVIEWED },
      { body: "b2", authorAssociation: "NONE", lastEditedAt: "2026-01-02T00:00:00Z", commitOid: null },
      { body: "", authorAssociation: "MEMBER", lastEditedAt: null, commitOid: null },
    ]);
  });

  it("asks through argv, never a shell, for exactly this pull request", () => {
    const deps = stub(page("reviews", []));
    prReviews(deps, 42);
    const argv = deps.calls[0];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(argv).toContain("number=42");
    expect(argv.find((a) => a.startsWith("query="))).toMatch(/reviews\(first:\d+/);
    expect(argv.find((a) => a.startsWith("query="))).toContain("commit{oid}");
  });

  it("follows pagination with the cursor and concatenates in order", () => {
    const deps = stub(
      page("reviews", [{ body: "one", authorAssociation: "OWNER" }], "CUR1"),
      page("reviews", [{ body: "two", authorAssociation: "OWNER" }]),
    );
    const out = prReviews(deps, 1);
    expect(out.map((r) => r.body)).toEqual(["one", "two"]);
    expect(deps.calls[0]).not.toContain("cursor=CUR1");
    expect(deps.calls[1]).toContain("cursor=CUR1");
  });

  it("returns null, never a partial list, when anything goes wrong", () => {
    expect(prReviews(stub({ status: 1, stdout: "", stderr: "boom" }), 1)).toBeNull();
    expect(prReviews(stub({ status: 0, stdout: "not json", stderr: "" }), 1)).toBeNull();
    expect(prReviews(stub(ok({ errors: [{ message: "x" }] })), 1)).toBeNull();
    expect(prReviews(stub(ok({ data: { repository: { pullRequest: null } } })), 1)).toBeNull();
    expect(
      prReviews(stub(page("reviews", [{ body: "p1", authorAssociation: "OWNER" }], "C"), { status: 1, stdout: "", stderr: "" }), 1),
    ).toBeNull();
  });

  it("returns null when the page cap is hit with pages still outstanding", () => {
    const forever = () => page("reviews", [{ body: "x", authorAssociation: "OWNER" }], "MORE");
    expect(prReviews(stub(forever), 1)).toBeNull();
  });
});

describe("prReviewThreads", () => {
  it("reports resolution and the first comment's body", () => {
    const deps = stub(
      page("reviewThreads", [
        { isResolved: false, comments: { nodes: [{ body: "fix <!-- post-pr-review:v1:0123456789abcdef -->" }] } },
        { isResolved: true, comments: { nodes: [] } },
        { comments: { nodes: [{ body: "human" }] } },
      ]),
    );
    expect(prReviewThreads(deps, 7)).toEqual([
      { isResolved: false, rootBody: "fix <!-- post-pr-review:v1:0123456789abcdef -->" },
      { isResolved: true, rootBody: "" },
      { isResolved: false, rootBody: "human" },
    ]);
  });

  it("treats a thread with no resolution flag as unresolved, the safe direction", () => {
    const deps = stub(page("reviewThreads", [{ comments: { nodes: [{ body: "x" }] } }]));
    expect(prReviewThreads(deps, 1)[0].isResolved).toBe(false);
  });

  it("paginates and fails closed like the reviews reader", () => {
    const deps = stub(
      page("reviewThreads", [{ isResolved: true, comments: { nodes: [] } }], "C1"),
      page("reviewThreads", [{ isResolved: true, comments: { nodes: [] } }]),
    );
    expect(prReviewThreads(deps, 1)).toHaveLength(2);
    expect(prReviewThreads(stub({ status: 1, stdout: "", stderr: "" }), 1)).toBeNull();
    expect(prReviewThreads(stub(ok({ errors: [{}] })), 1)).toBeNull();
    const forever = () => page("reviewThreads", [{ isResolved: true, comments: { nodes: [] } }], "MORE");
    expect(prReviewThreads(stub(forever), 1)).toBeNull();
  });

  it("selects thread resolution and the root comment in the query", () => {
    const deps = stub(page("reviewThreads", []));
    prReviewThreads(deps, 3);
    const query = deps.calls[0].find((a) => a.startsWith("query="));
    expect(query).toMatch(/reviewThreads\(first:\d+/);
    expect(query).toContain("isResolved");
    expect(query).toMatch(/comments\(first:1\)/);
  });
});

describe("commitIsAncestor", () => {
  const run = (status, stderr = "") => stub({ status, stdout: "", stderr });

  it("asks git with argv and reads the exit status", () => {
    const deps = run(0);
    expect(commitIsAncestor(deps, REVIEWED, HEAD)).toBe(true);
    expect(deps.calls[0]).toEqual(["git", "merge-base", "--is-ancestor", REVIEWED, HEAD]);
    expect(commitIsAncestor(run(1), REVIEWED, HEAD)).toBe(false);
  });

  it("throws when git cannot decide, rather than answering no", () => {
    // Exit 128 is an unknown commit: "not an ancestor" would be a claim about
    // history the clone cannot see.
    expect(() => commitIsAncestor(run(128, "fatal: Not a valid commit name"), REVIEWED, HEAD)).toThrow(/Not a valid commit/);
    expect(() => commitIsAncestor(run(2), REVIEWED, HEAD)).toThrow();
  });

  it("refuses anything that is not a full commit id before running git", () => {
    const deps = run(0);
    for (const bad of ["--upload-pack=x", "abc", "", "z".repeat(40), `${REVIEWED} extra`]) {
      expect(() => commitIsAncestor(deps, bad, HEAD), bad).toThrow(/commit/);
      expect(() => commitIsAncestor(deps, REVIEWED, bad), bad).toThrow(/commit/);
    }
    expect(deps.calls).toEqual([]);
  });
});

describe("reviewEntryFacts", () => {
  const attest = () =>
    renderAttestationHeader(
      buildAttestationPayload({ headSha: HEAD, legs: [{ name: "test", mode: "hard", status: "pass" }], now: NOW }),
    );
  const review = (headSha = HEAD) =>
    renderReviewComment(
      buildReviewPayload({ headSha, reviewedSha: REVIEWED, findings: { posted: 0, unresolved: 0 }, now: NOW }),
    );
  const node = (body, over = {}) => ({ body, authorAssociation: "OWNER", lastEditedAt: null, author: { login: "kaio" }, ...over });
  const deps = (nodes) => stub(page("comments", nodes));

  it("reports both facts for a head that was reviewed and attested", () => {
    expect(reviewEntryFacts(deps([node(review()), node(attest())]), 5, HEAD)).toMatchObject({
      reviewedAtHead: true,
      attestedAtHead: true,
    });
  });

  it("keeps the two facts independent", () => {
    expect(reviewEntryFacts(deps([node(attest())]), 5, HEAD)).toMatchObject({ reviewedAtHead: false, attestedAtHead: true });
    expect(reviewEntryFacts(deps([node(review())]), 5, HEAD)).toMatchObject({ reviewedAtHead: true, attestedAtHead: false });
  });

  it("does not count evidence for another commit or from an untrusted author", () => {
    const facts = reviewEntryFacts(
      deps([node(review(OTHER)), node(review(), { authorAssociation: "NONE" }), node(attest(), { lastEditedAt: "2026-01-02T00:00:00Z" })]),
      5,
      HEAD,
    );
    expect(facts).toMatchObject({ reviewedAtHead: false, attestedAtHead: false });
    expect(facts.review.code).toBe("REVIEW_STALE");
  });

  it("reports neither, and says why, when the comments cannot be read", () => {
    const facts = reviewEntryFacts(stub({ status: 1, stdout: "", stderr: "" }), 5, HEAD);
    expect(facts).toMatchObject({ reviewedAtHead: false, attestedAtHead: false });
    expect(facts.review.code).toBe("REVIEW_INVALID");
  });
});

describe("the GraphQL requests, exactly", () => {
  const HEADER = "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){";
  const argvFor = (extra = []) => [
    "gh",
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    "number=42",
    ...extra,
  ];

  it("asks for reviews with their author, edit state and commit, and nothing else", () => {
    const deps = stub(page("reviews", []));
    prReviews(deps, 42);
    expect(deps.calls[0]).toEqual(
      argvFor([
        "-f",
        `query=${HEADER}pullRequest(number:$number){reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{body authorAssociation lastEditedAt commit{oid}}}}}}`,
      ]),
    );
  });

  it("asks for threads with their resolution and first comment, and nothing else", () => {
    const deps = stub(page("reviewThreads", []));
    prReviewThreads(deps, 42);
    expect(deps.calls[0]).toEqual(
      argvFor([
        "-f",
        `query=${HEADER}pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved comments(first:1){nodes{body}}}}}}}`,
      ]),
    );
  });

  it("passes the cursor as its own -f pair, ahead of the query", () => {
    const deps = stub(page("reviews", [], "CUR9"), page("reviews", []));
    prReviews(deps, 42);
    const second = deps.calls[1];
    expect(second.slice(0, 9)).toEqual(argvFor());
    expect(second[9]).toBe("-f");
    expect(second[10]).toBe("cursor=CUR9");
    expect(second[11]).toBe("-f");
    expect(second[12]).toMatch(/^query=query\(/);
    expect(second).toHaveLength(13);
  });

  it("stops at exactly the page cap", () => {
    const forever = () => page("reviews", [{ body: "x", authorAssociation: "OWNER" }], "MORE");
    const deps = stub(forever);
    expect(prReviews(deps, 1)).toBeNull();
    expect(deps.calls).toHaveLength(100);
  });
});

describe("malformed responses fail closed without throwing", () => {
  const cases = {
    "an empty object": {},
    "a null body": null,
    "no repository": { data: {} },
    "a null data": { data: null },
    "a null repository": { data: { repository: null } },
    "no pull request": { data: { repository: {} } },
    "a null pull request": { data: { repository: { pullRequest: null } } },
    "no connection": { data: { repository: { pullRequest: {} } } },
    "a non-empty errors array": { errors: [{ message: "x" }], data: null },
  };

  for (const [label, body] of Object.entries(cases)) {
    it(`treats ${label} as unreadable`, () => {
      expect(prReviews(stub(ok(body)), 1), label).toBeNull();
      expect(prReviewThreads(stub(ok(body)), 1), label).toBeNull();
    });
  }

  it("does not treat an empty errors array as a failure", () => {
    const withErrors = ok({
      errors: [],
      data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
    });
    expect(prReviews(stub(withErrors), 1)).toEqual([]);
  });

  it("ignores an errors field that is not an array", () => {
    const withErrors = ok({
      errors: "none",
      data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
    });
    expect(prReviews(stub(withErrors), 1)).toEqual([]);
  });

  it("refuses a non-zero exit even when stdout happens to be valid", () => {
    const valid = JSON.parse(page("reviews", []).stdout);
    expect(prReviews(stub({ status: 1, stdout: JSON.stringify(valid), stderr: "" }), 1)).toBeNull();
  });

  it("reads a connection with no pageInfo or nodes as a complete, empty page", () => {
    const bare = ok({ data: { repository: { pullRequest: { reviews: {}, reviewThreads: { nodes: [] } } } } });
    expect(prReviews(stub(bare), 1)).toEqual([]);
    expect(prReviewThreads(stub(bare), 1)).toEqual([]);
  });

  it("defaults every field of a sparse node", () => {
    expect(prReviews(stub(page("reviews", [{}])), 1)).toEqual([
      { body: "", authorAssociation: "", lastEditedAt: null, commitOid: null },
    ]);
    expect(prReviews(stub(page("reviews", [null])), 1)).toEqual([
      { body: "", authorAssociation: "", lastEditedAt: null, commitOid: null },
    ]);
  });

  it("reads a thread whose comments are missing, empty or sparse as having no body", () => {
    for (const node of [{}, { comments: {} }, { comments: { nodes: [] } }, { comments: { nodes: [{}] } }, { comments: { nodes: [null] } }]) {
      expect(prReviewThreads(stub(page("reviewThreads", [node])), 1)[0].rootBody, JSON.stringify(node)).toBe("");
    }
  });
});

describe("commitIsAncestor: validation and messages", () => {
  const run = (status, stderr = "") => stub({ status, stdout: "", stderr });

  it("rejects a commit id with anything before or after the 40 hex characters", () => {
    for (const bad of [`${REVIEWED}0`, `0${REVIEWED}`, ` ${REVIEWED}`, `${REVIEWED}\n`]) {
      expect(() => commitIsAncestor(run(0), bad, HEAD), JSON.stringify(bad)).toThrow(/commit/);
      expect(() => commitIsAncestor(run(0), REVIEWED, bad), JSON.stringify(bad)).toThrow(/commit/);
    }
  });

  it("rejects a non-string that would coerce to a valid id", () => {
    expect(() => commitIsAncestor(run(0), [REVIEWED], HEAD)).toThrow(/commit/);
    expect(() => commitIsAncestor(run(0), REVIEWED, { toString: () => HEAD })).toThrow(/commit/);
  });

  it("explains a failure with git's own words, or the exit status when git said nothing", () => {
    expect(() => commitIsAncestor(run(128, "  fatal: bad object  \n"), REVIEWED, HEAD)).toThrow(/^fatal: bad object$/);
    expect(() => commitIsAncestor(run(2, ""), REVIEWED, HEAD)).toThrow(/^git merge-base exited 2$/);
  });
});
