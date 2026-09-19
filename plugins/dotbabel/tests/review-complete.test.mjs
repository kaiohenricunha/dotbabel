import { describe, it, expect } from "vitest";

import { postReviewComplete } from "../src/review-complete.mjs";
import { CRITERIA_MARKER_PREFIX } from "../src/criteria/comment.mjs";
import {
  POST_PR_REVIEW_RECEIPT_MARKER,
  REVIEW_MARKER_PREFIX,
  evaluateReviewEvidence,
  parseReviewComment,
} from "../src/review-evidence.mjs";

const HEAD = "a".repeat(40);
const MOVED = "d".repeat(40);
const REVIEWED = "b".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");
const FINDING = "<!-- post-pr-review:v1:0123456789abcdef -->";

const receiptReview = (over = {}) => ({
  body: `${POST_PR_REVIEW_RECEIPT_MARKER}\npost-pr-review: 1 posted`,
  authorAssociation: "OWNER",
  lastEditedAt: null,
  commit: { oid: REVIEWED },
  ...over,
});

/**
 * A fake gh/git transport. `views` are served in order and the last repeats, so
 * a test can move the head between the first read and the pre-post re-read.
 */
function world({
  views = [{ headRefOid: HEAD, state: "OPEN" }],
  reviews = [receiptReview()],
  threads = [{ isResolved: true, comments: { nodes: [{ body: `fixed ${FINDING}` }] } }],
  ancestor = 0,
  reviewsStatus = 0,
  threadsStatus = 0,
  existing = [],
  postError = null,
} = {}) {
  const posted = [];
  const minimized = [];
  const calls = [];
  let viewIndex = 0;
  const page = (field, nodes) => ({
    status: 0,
    stdout: JSON.stringify({
      data: { repository: { pullRequest: { [field]: { pageInfo: { hasNextPage: false }, nodes } } } },
    }),
    stderr: "",
  });
  return {
    posted,
    minimized,
    calls,
    deps: {
      run(argv) {
        calls.push(argv);
        const joined = argv.join(" ");
        if (argv[0] === "git" && argv[1] === "merge-base") return { status: ancestor, stdout: "", stderr: "" };
        if (joined.includes("reviewThreads(")) {
          return threadsStatus === 0 ? page("reviewThreads", threads) : { status: threadsStatus, stdout: "", stderr: "x" };
        }
        if (joined.includes("reviews(")) {
          return reviewsStatus === 0 ? page("reviews", reviews) : { status: reviewsStatus, stdout: "", stderr: "x" };
        }
        throw new Error(`unexpected run: ${joined}`);
      },
      capture(argv) {
        calls.push(argv);
        const joined = argv.join(" ");
        if (/^gh pr view \d+ --json headRefOid,state$/.test(joined)) {
          const v = views[Math.min(viewIndex, views.length - 1)];
          viewIndex += 1;
          if (v instanceof Error) throw v;
          return JSON.stringify(v);
        }
        if (joined === "gh repo view --json nameWithOwner --jq .nameWithOwner") return "o/r\n";
        if (/^gh api user\b/.test(joined)) return "kaio";
        if (/comments --paginate$/.test(joined)) return JSON.stringify(existing);
        if (/^gh api graphql\b/.test(joined)) {
          minimized.push(argv.find((a) => a.startsWith("id=")));
          return "{}";
        }
        throw new Error(`unexpected capture: ${joined}`);
      },
      ghApiWithInput(argv, payload) {
        if (postError) throw new Error(postError);
        posted.push({ argv, payload });
      },
      log() {},
    },
  };
}

const run = (w, over = {}) =>
  postReviewComplete(w.deps, { prNumber: 7, criteriaReasons: () => [], now: NOW, ...over });

describe("postReviewComplete", () => {
  it("posts a review-complete comment naming the head when every condition holds", () => {
    const w = world();
    const r = run(w);
    expect(r).toMatchObject({ ok: true, posted: true, headSha: HEAD, reviewedSha: REVIEWED });
    expect(w.posted).toHaveLength(1);
    const body = w.posted[0].payload.body;
    expect(body.split("\n")[0]).toBe(`${REVIEW_MARKER_PREFIX}${HEAD} -->`);
    expect(w.posted[0].argv.join(" ")).toContain("repos/o/r/issues/7/comments");
    // The producer's output is exactly what the reader accepts: the two cannot drift.
    expect(
      evaluateReviewEvidence({
        comments: [{ body, authorAssociation: "OWNER", lastEditedAt: null }],
        headSha: HEAD,
      }).state,
    ).toBe("reviewed");
  });

  it("records what it counted, including advisory threads it did not block on", () => {
    const w = world({
      threads: [
        { isResolved: true, comments: { nodes: [{ body: FINDING }] } },
        { isResolved: true, comments: { nodes: [{ body: FINDING.replace("0123", "4567") }] } },
        { isResolved: false, comments: { nodes: [{ body: "advisory: this test asserts nothing" }] } },
      ],
    });
    expect(run(w)).toMatchObject({ ok: true, counts: { findingsPosted: 2, findingsUnresolved: 0, otherOpenThreads: 1 } });
    const payload = parseReviewComment(w.posted[0].payload.body).payload;
    expect(payload.findings).toEqual({ posted: 2, unresolved: 0 });
    expect(payload.other_open_threads).toBe(1);
    expect(payload.reviewed_sha).toBe(REVIEWED);
  });

  it("records the tool version when the caller knows it", () => {
    const w = world();
    run(w, { toolVersion: "9.9.9" });
    expect(parseReviewComment(w.posted[0].payload.body).payload.tool.version).toBe("9.9.9");
  });

  it("supersedes only its own older review-complete comments", () => {
    const w = world({
      existing: [
        { user: { login: "kaio" }, node_id: "OLD_REVIEW", body: `${REVIEW_MARKER_PREFIX}${MOVED} -->\nold` },
        { user: { login: "kaio" }, node_id: "CRITERIA", body: `${CRITERIA_MARKER_PREFIX}${MOVED} -->\nold` },
      ],
    });
    run(w);
    expect(w.minimized).toEqual(["id=OLD_REVIEW"]);
  });

  it("prints the comment and posts nothing on a dry run", () => {
    const w = world();
    const r = run(w, { dryRun: true });
    expect(r).toMatchObject({ ok: true, posted: false });
    expect(r.body.split("\n")[0]).toBe(`${REVIEW_MARKER_PREFIX}${HEAD} -->`);
    expect(w.posted).toEqual([]);
    expect(w.minimized).toEqual([]);
  });

  it("posts nothing without a post-pr-review receipt", () => {
    const w = world({ reviews: [] });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, posted: false });
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_NO_RECEIPT"]);
    expect(w.posted).toEqual([]);
  });

  it("posts nothing while a finding the review posted is still unresolved", () => {
    const w = world({ threads: [{ isResolved: false, comments: { nodes: [{ body: `open ${FINDING}` }] } }] });
    const r = run(w);
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_FINDINGS_OPEN"]);
    expect(w.posted).toEqual([]);
  });

  it("posts nothing while the criteria check has a blocking reason", () => {
    const w = world();
    const r = run(w, { criteriaReasons: () => [{ code: "CRITERIA_FAILED", message: "AC-1 failed" }] });
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_CRITERIA_BLOCKED"]);
    expect(r.reasons[0].message).toContain("CRITERIA_FAILED");
    expect(w.posted).toEqual([]);
  });

  it("hands the criteria check this pull request and its head", () => {
    const w = world();
    const seen = [];
    run(w, {
      criteriaReasons: (...args) => {
        seen.push(args);
        return [];
      },
    });
    expect(seen).toEqual([[7, HEAD]]);
  });

  it("fails closed when reviews, threads or ancestry cannot be read", () => {
    for (const over of [{ reviewsStatus: 1 }, { threadsStatus: 1 }, { ancestor: 128 }]) {
      const w = world(over);
      const r = run(w);
      expect(r.ok, JSON.stringify(over)).toBe(false);
      expect(r.reasons.some((x) => x.code === "REVIEW_UNREADABLE"), JSON.stringify(over)).toBe(true);
      expect(w.posted).toEqual([]);
    }
  });

  it("refuses a receipt for a commit outside this history", () => {
    const w = world({ ancestor: 1 });
    expect(run(w).reasons.map((x) => x.code)).toEqual(["REVIEW_NO_RECEIPT"]);
    expect(w.posted).toEqual([]);
  });

  it("does nothing for a pull request that is not open", () => {
    for (const state of ["MERGED", "CLOSED"]) {
      const w = world({ views: [{ headRefOid: HEAD, state }] });
      const r = run(w);
      expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_PR_NOT_OPEN"]);
      expect(w.calls.some((c) => c.join(" ").includes("reviews("))).toBe(false);
      expect(w.posted).toEqual([]);
    }
  });

  it("refuses to post when the head moved while it was gathering", () => {
    // Evidence is pinned to a SHA, so posting for a head that is no longer the
    // head would attest a commit nobody reviewed.
    const w = world({ views: [{ headRefOid: HEAD, state: "OPEN" }, { headRefOid: MOVED, state: "OPEN" }] });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, posted: false });
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_HEAD_MOVED"]);
    expect(r.reasons[0].message).toContain(HEAD.slice(0, 8));
    expect(r.reasons[0].message).toContain(MOVED.slice(0, 8));
    expect(w.posted).toEqual([]);
  });

  it("does not re-read the head on a dry run, since nothing is posted", () => {
    const w = world({ views: [{ headRefOid: HEAD, state: "OPEN" }, { headRefOid: MOVED, state: "OPEN" }] });
    expect(run(w, { dryRun: true }).ok).toBe(true);
  });

  it("reports an environment failure instead of a verdict when the pull request cannot be read", () => {
    const w = world({ views: [new Error("gh: not logged in")] });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, env: true, posted: false });
    expect(r.message).toContain("not logged in");
    const bad = world({ views: [{ headRefOid: "nope", state: "OPEN" }] });
    expect(run(bad)).toMatchObject({ ok: false, env: true });
  });

  it("reports an environment failure when the criteria check itself throws", () => {
    const w = world();
    const r = run(w, {
      criteriaReasons: () => {
        throw new Error("spec dir unreadable");
      },
    });
    expect(r).toMatchObject({ ok: false, env: true, posted: false });
    expect(r.message).toContain("spec dir unreadable");
    expect(w.posted).toEqual([]);
  });
});

describe("postReviewComplete: messages and boundaries", () => {
  it("says which state a pull request that is not open is in", () => {
    const w = world({ views: [{ headRefOid: HEAD, state: "MERGED" }] });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, posted: false });
    expect(r.reasons[0].message).toBe("the pull request is MERGED");
  });

  it("treats a missing state as not open", () => {
    const w = world({ views: [{ headRefOid: HEAD }] });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, posted: false });
    expect(r.reasons[0]).toEqual({ code: "REVIEW_PR_NOT_OPEN", message: "the pull request is not open" });
  });

  it("names the old head before the new one when the head moves", () => {
    const w = world({ views: [{ headRefOid: HEAD, state: "OPEN" }, { headRefOid: MOVED, state: "OPEN" }] });
    expect(run(w).reasons[0].message).toBe(
      `the head moved from ${HEAD.slice(0, 8)} to ${MOVED.slice(0, 8)} while the review was being checked`,
    );
  });

  it("explains an unreadable head", () => {
    for (const view of ["null", '{"headRefOid":123,"state":"OPEN"}', "{}"]) {
      const w = world();
      w.deps.capture = () => view;
      const r = run(w);
      expect(r, view).toMatchObject({ ok: false, env: true, posted: false });
      expect(r.message, view).toBe("the pull request head SHA could not be read");
    }
  });

  it("rejects a head with anything around the 40 hex characters", () => {
    for (const headRefOid of [`${HEAD}0`, `0${HEAD}`]) {
      const r = run(world({ views: [{ headRefOid, state: "OPEN" }] }));
      expect(r, headRefOid).toMatchObject({ ok: false, env: true });
    }
  });

  it("reports an environment failure, and posts nothing, when the post itself fails", () => {
    const w = world({ postError: "HTTP 502" });
    const r = run(w);
    expect(r).toMatchObject({ ok: false, env: true, posted: false });
    expect(r.message).toBe("HTTP 502");
    expect(w.posted).toEqual([]);
  });
});
