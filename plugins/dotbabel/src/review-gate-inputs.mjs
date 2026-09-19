/**
 * review-gate-inputs — the I/O half of review-complete evidence.
 *
 * `review-evidence.mjs` is pure; this module gathers what it judges. Every
 * reader returns `null` (or throws, for ancestry) rather than a partial answer:
 * a list that could not be read completely must never look like a list with
 * nothing in it, because "no unresolved thread" and "could not read the threads"
 * lead to opposite decisions.
 *
 * @typedef {{run: (argv: string[]) => {status: number, stdout: string, stderr: string}}} GateDeps
 */

import { hasCurrentAttestation } from "./attestation.mjs";
import { prComments } from "./criteria/gate-inputs.mjs";
import { evaluateReviewEvidence } from "./review-evidence.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const REVIEWS_QUERY = [
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){",
  "repository(owner:$owner,name:$repo){",
  `pullRequest(number:$number){reviews(first:${PAGE_SIZE},after:$cursor){`,
  "pageInfo{hasNextPage endCursor}",
  "nodes{body authorAssociation lastEditedAt commit{oid}}",
  "}}}}",
].join("");

const THREADS_QUERY = [
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){",
  "repository(owner:$owner,name:$repo){",
  `pullRequest(number:$number){reviewThreads(first:${PAGE_SIZE},after:$cursor){`,
  "pageInfo{hasNextPage endCursor}",
  "nodes{isResolved comments(first:1){nodes{body}}}",
  "}}}}",
].join("");

/**
 * Read every node of one pull-request connection, or null.
 *
 * @template T
 * @param {GateDeps} deps
 * @param {number} prNumber
 * @param {{ field: string, query: string, map: (node: any) => T }} spec
 * @returns {T[]|null}
 */
function readConnection(deps, prNumber, { field, query, map }) {
  const out = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // `-F` for owner/repo because only that flag expands the placeholders; `-f`
    // for the cursor so an all-digit cursor is not coerced into a number. As
    // argv entries no shell ever sees them.
    const argv = ["gh", "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${prNumber}`];
    if (cursor !== null) argv.push("-f", `cursor=${cursor}`);
    argv.push("-f", `query=${query}`);
    const r = deps.run(argv);
    if (r.status !== 0) return null;

    let data;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      return null;
    }
    // A GraphQL error can arrive as HTTP 200, so a status check alone would
    // accept a response that carries nothing.
    if (Array.isArray(data?.errors) && data.errors.length > 0) return null;

    const conn = data?.data?.repository?.pullRequest?.[field];
    if (!conn) return null;
    for (const node of conn.nodes ?? []) out.push(map(node ?? {}));
    if (!conn.pageInfo?.hasNextPage) return out;
    cursor = conn.pageInfo.endCursor;
  }
  // The cap was reached with pages outstanding: a truncated list that looks
  // complete is exactly what must not be returned.
  return null;
}

/**
 * Every review on the pull request, with the commit each was posted against.
 *
 * @param {GateDeps} deps
 * @param {number} prNumber
 * @returns {Array<{body: string, authorAssociation: string, lastEditedAt: string|null, commitOid: string|null}>|null}
 */
export function prReviews(deps, prNumber) {
  return readConnection(deps, prNumber, {
    field: "reviews",
    query: REVIEWS_QUERY,
    map: (n) => ({
      body: String(n.body ?? ""),
      authorAssociation: String(n.authorAssociation ?? ""),
      lastEditedAt: n.lastEditedAt ?? null,
      commitOid: n.commit?.oid ?? null,
    }),
  });
}

/**
 * Every review thread, with its resolution and the body of its first comment.
 * A thread with no resolution flag counts as unresolved, the safe direction.
 *
 * @param {GateDeps} deps
 * @param {number} prNumber
 * @returns {Array<{isResolved: boolean, rootBody: string}>|null}
 */
export function prReviewThreads(deps, prNumber) {
  return readConnection(deps, prNumber, {
    field: "reviewThreads",
    query: THREADS_QUERY,
    map: (n) => ({
      isResolved: n.isResolved === true,
      rootBody: String(n.comments?.nodes?.[0]?.body ?? ""),
    }),
  });
}

/**
 * True when `oid` is an ancestor of (or equal to) `headSha`.
 *
 * Throws when git cannot decide. Exit 1 is a definite "no"; anything else
 * (128 for an unknown commit, for instance) means the clone cannot see the
 * history, and answering "not an ancestor" would be a claim it cannot back.
 *
 * @param {GateDeps} deps
 * @param {string} oid
 * @param {string} headSha
 * @returns {boolean}
 */
export function commitIsAncestor(deps, oid, headSha) {
  for (const sha of [oid, headSha]) {
    if (typeof sha !== "string" || !FULL_SHA_RE.test(sha)) {
      throw new Error(`not a full commit id: ${JSON.stringify(sha)}`);
    }
  }
  const r = deps.run(["git", "merge-base", "--is-ancestor", oid, headSha]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(r.stderr.trim() || `git merge-base exited ${r.status}`);
}

/**
 * What the conductor needs to pick an entry phase for an open pull request.
 *
 * @param {GateDeps} deps
 * @param {number} prNumber
 * @param {string} headSha
 * @returns {{ reviewedAtHead: boolean, attestedAtHead: boolean, review: import("./review-evidence.mjs").ReviewEvidence }}
 */
export function reviewEntryFacts(deps, prNumber, headSha) {
  const comments = prComments(deps, prNumber);
  const review = evaluateReviewEvidence({ comments, headSha });
  return {
    reviewedAtHead: review.state === "reviewed",
    attestedAtHead: hasCurrentAttestation({ comments, headSha }),
    review,
  };
}
