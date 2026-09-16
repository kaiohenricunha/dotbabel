/**
 * Gathers the §5 criteria inputs that `checkMergeGate` judges.
 *
 * `pr-gates.mjs` is deliberately free of I/O — it only decides — so every fact
 * the criteria rules need is collected here and handed in. Dependencies arrive
 * through a `deps` object exposing `sh`, the same injection shape
 * `criteria/preconditions.mjs` and `local-attest-runner.mjs` use, so the whole
 * gather can be exercised without a repository, a network, or a `gh` token.
 *
 * The ref split is the security property (KD-14, REL-16): specs and the
 * criteria configuration for the RULES come from the base ref, while the
 * evidence and the check run come from the head. A pull request must not be
 * able to relax the rules that judge it by editing them in its own branch.
 */
import { parseSpecIds } from "../lib/spec-ids.mjs";
import { loadCriteriaConfigText } from "./config.mjs";

/** The check-run name KD-10 gives the criteria job in the CI templates. */
export const CRITERIA_CHECK_NAME = "dotbabel criteria";

/** Page size and cap for the comment fetch: 100 pages is 10,000 comments. */
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;

const RE_CRITERIA_RATIONALE = /^ {0,3}##[ \t]+Criteria change rationale[ \t]*$/im;

const COMMENTS_QUERY = [
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){",
  "repository(owner:$owner,name:$repo){",
  `pullRequest(number:$number){comments(first:${COMMENT_PAGE_SIZE},after:$cursor){`,
  "pageInfo{hasNextPage endCursor}",
  "nodes{body authorAssociation lastEditedAt author{login}}",
  "}}}}",
].join("");

/**
 * @typedef {{sh: (cmd: string) => {status: number, stdout: string, stderr: string}}} GateDeps
 */

/**
 * Quote a value for a `shell: true` command line.
 *
 * Single quotes, not `JSON.stringify`: a GraphQL query is full of `$owner`,
 * `$repo` and `$cursor` variable sigils, and inside double quotes the shell
 * expands every one of them to the empty string. The query then reaches the
 * API malformed and the whole comment fetch fails — which the merge gate
 * correctly, and confusingly, reports as unreadable evidence.
 *
 * @param {string} value
 * @returns {string}
 */
function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the criteria half of the merge-gate input.
 *
 * Returns `{}` — not a set of empty criteria fields — when the pull request
 * has no ref information or declares no Spec ID. That distinction matters:
 * `{}` leaves `checkMergeGate` on exactly its pre-criteria behaviour, so a
 * repository that never adopted criteria sees no change at all.
 *
 * @param {GateDeps} deps
 * @param {{body?: string, headRefOid?: string, baseRefOid?: string}} view `gh pr view` JSON.
 * @param {number} prNumber
 * @returns {object}
 */
export function criteriaGateInputs(deps, view, prNumber) {
  const headSha = String(view?.headRefOid ?? "");
  const baseSha = String(view?.baseRefOid ?? "");
  if (headSha === "" || baseSha === "") return {};

  const body = String(view?.body ?? "");
  const specIds = parseSpecIds(body);
  if (specIds.length === 0) return {};

  /** @type {Record<string, string[]>} */
  const requiredCriteria = {};
  /** @type {Record<string, string[]>} */
  const baseActiveCriteria = {};
  const unknownSpecIds = [];

  for (const id of specIds) {
    const head = activeCriteriaAt(deps, headSha, id);
    if (head === null) unknownSpecIds.push(id);
    else requiredCriteria[id] = head;

    const base = activeCriteriaAt(deps, baseSha, id);
    if (base !== null) baseActiveCriteria[id] = base;
  }

  const config = criteriaConfigAt(deps, baseSha);
  return {
    headRefOid: headSha,
    requiredCriteria,
    baseActiveCriteria,
    unknownSpecIds,
    criteriaChangeRationale: RE_CRITERIA_RATIONALE.test(body),
    criteriaEnforcement: config.enforcement,
    trustedAssociations: config.trusted_associations,
    requireCiCheck: config.require_ci_check,
    comments: prComments(deps, prNumber),
    ciCriteriaCheck: config.require_ci_check ? criteriaCheckConclusion(deps, headSha) : null,
  };
}

/**
 * The active criterion ids a spec declares at one ref, or null when the spec
 * does not exist or does not parse there.
 *
 * `null` and `[]` are different answers: an unknown spec is a body error that
 * blocks (REL-16), while an empty one simply has nothing to prove.
 *
 * @param {GateDeps} deps
 * @param {string} sha
 * @param {string} specId
 * @returns {string[]|null}
 */
function activeCriteriaAt(deps, sha, specId) {
  const r = deps.sh(`git show ${sha}:docs/specs/${specId}/spec.json`);
  if (r.status !== 0) return null;
  try {
    const spec = JSON.parse(r.stdout);
    return (spec.acceptance_criteria ?? [])
      .filter((c) => c && (c.status ?? "active") !== "planned")
      .map((c) => c.id);
  } catch {
    // Unparseable at this ref: treat as absent rather than throwing. At the
    // head that lands the id in unknownSpecIds and the gate blocks; at the
    // base it means nothing can be proven weakened, which is the safe read.
    return null;
  }
}

/**
 * The `criteria` key of `.dotbabel.json` at one ref, with defaults.
 *
 * @param {GateDeps} deps
 * @param {string} sha
 * @returns {ReturnType<typeof loadCriteriaConfigText>}
 */
function criteriaConfigAt(deps, sha) {
  const r = deps.sh(`git show ${sha}:.dotbabel.json`);
  return loadCriteriaConfigText(r.status === 0 ? r.stdout : null, `${sha}:.dotbabel.json`);
}

/**
 * Every issue comment on the pull request, with the fields the gate needs.
 *
 * GraphQL rather than `gh pr view --json comments` because only GraphQL
 * exposes `lastEditedAt`, and an edited comment is one the gate must refuse —
 * the text it would read is not the text the tool wrote.
 *
 * Returns null, never a partial list, when any page fails. REL-3 makes the
 * gate fail closed on that null; an empty array would read as "no evidence
 * comment exists", which is a different and much weaker claim.
 *
 * @param {GateDeps} deps
 * @param {number} prNumber
 * @returns {Array<{body: string, authorAssociation: string, authorLogin: string|null, lastEditedAt: string|null}>|null}
 */
function prComments(deps, prNumber) {
  const out = [];
  let cursor = null;

  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    // `-F` for owner/repo because only that flag expands the {owner}/{repo}
    // placeholders; `-f` for the cursor so an all-digit cursor is not coerced
    // into a number.
    const cursorArg = cursor === null ? "" : ` -f cursor=${shQuote(cursor)}`;
    const r = deps.sh(
      `gh api graphql -F owner={owner} -F repo={repo} -F number=${prNumber}${cursorArg} -f query=${shQuote(COMMENTS_QUERY)}`,
    );
    if (r.status !== 0) return null;

    let data;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      return null;
    }
    // A GraphQL error can arrive as HTTP 200 with an `errors` array, so a
    // status check alone would accept a response carrying no comments at all.
    if (Array.isArray(data?.errors) && data.errors.length > 0) return null;

    const conn = data?.data?.repository?.pullRequest?.comments;
    if (!conn) return null;
    for (const n of conn.nodes ?? []) {
      out.push({
        body: String(n.body ?? ""),
        authorAssociation: String(n.authorAssociation ?? ""),
        authorLogin: n.author?.login ?? null,
        lastEditedAt: n.lastEditedAt ?? null,
      });
    }
    if (!conn.pageInfo?.hasNextPage) return out;
    cursor = conn.pageInfo.endCursor;
  }

  // The cap was reached with pages still outstanding. Returning `out` would
  // hand the gate a truncated list that looks complete, and the evidence
  // comment could be in the part never fetched.
  return null;
}

/**
 * The conclusion of the `dotbabel criteria` check run on the head SHA, or null
 * when no such check exists.
 *
 * @param {GateDeps} deps
 * @param {string} headSha
 * @returns {string|null}
 */
function criteriaCheckConclusion(deps, headSha) {
  // No `--paginate`: this endpoint returns an object, and gh concatenates one
  // JSON object per page, which JSON.parse rejects — the whole lookup would
  // then always answer null. `per_page=100` covers any realistic check matrix.
  const r = deps.sh(`gh api "repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100"`);
  if (r.status !== 0) return null;
  try {
    const runs = JSON.parse(r.stdout).check_runs ?? [];
    // Last wins: a re-run appends a newer run with the same name.
    const match = runs.filter((run) => run?.name === CRITERIA_CHECK_NAME).pop();
    return match ? (match.conclusion ?? null) : null;
  } catch {
    return null;
  }
}
