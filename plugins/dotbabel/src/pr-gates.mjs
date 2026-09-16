/**
 * pr-gates — pure precondition checks for the `pr-conductor` skill.
 *
 * Every export here is deterministic and free of I/O. The bin gathers state
 * (`git status --porcelain`, `gh pr view --json …`) and hands it in; these
 * functions only decide. That split is what lets the gates be exercised
 * without a live repo or a GitHub token.
 *
 * Each gate returns the same shape so callers can treat them uniformly and
 * `summarizeGates` can fold a list of them into one verdict.
 *
 * @typedef {object} GateReason
 * @property {string} code
 * @property {string} message
 * @property {string} [detail]
 *
 * @typedef {object} GateResult
 * @property {boolean} ok
 * @property {string} gate
 * @property {GateReason[]} reasons
 * @property {string|null} hint
 *
 * @typedef {object} ConductorPhase
 * @property {string} id
 * @property {string} artifact
 * @property {string} invocation
 *
 * @typedef {object} SkipCiVerdict
 * @property {boolean} present
 * @property {string|null} marker
 * @property {"subject"|"last-line"|"body"|"trailer"|null} location
 * @property {boolean} effective
 */

// Pure imports only: these modules do no I/O, so the "free of I/O"
// contract at the top of this file still holds. The gate parses evidence
// with the same code that writes it, so producer and judge cannot drift.
import { CRITERIA_MARKER_PREFIX } from "./criteria/comment.mjs";
import { parseEvidenceComment, evidencePayloadProblem, payloadCoverage } from "./criteria/evidence.mjs";
import { createMarker } from "./lib/attest-marker.mjs";

const criteriaMarker = createMarker(CRITERIA_MARKER_PREFIX);

/** @param {string} body @returns {string|null} */
function evidenceMarkerSha(body) {
  return criteriaMarker.parseSha(body);
}

/**
 * The canonical pipeline order. This is the single source of truth that the
 * bats contract test diffs `skills/pr-conductor/SKILL.md` against, so the
 * prose can never silently drift from the code.
 *
 * The terminal `stop` phase names `commands/merge-pr.md` as a HAND-OFF target.
 * The conductor never invokes it — merging requires an explicit human say-so.
 */
export const CONDUCTOR_PHASES = Object.freeze([
  Object.freeze({
    id: "pre-pr",
    artifact: "commands/pre-pr.md",
    invocation: "/pre-pr",
    conductorFlags: Object.freeze(["--conductor"]),
  }),
  Object.freeze({
    id: "open-pr",
    artifact: "skills/git/SKILL.md",
    invocation: "/git pr",
    conductorFlags: Object.freeze([]),
  }),
  Object.freeze({
    id: "post-pr-review",
    artifact: "skills/post-pr-review/SKILL.md",
    invocation: "/post-pr-review",
    conductorFlags: Object.freeze([]),
  }),
  Object.freeze({
    id: "review-pr",
    artifact: "skills/review-pr/SKILL.md",
    invocation: "/review-pr",
    conductorFlags: Object.freeze(["--conductor"]),
  }),
  Object.freeze({
    id: "local-attest",
    artifact: "skills/local-attest/SKILL.md",
    invocation: "/local-attest",
    conductorFlags: Object.freeze([]),
  }),
  Object.freeze({
    id: "stop",
    artifact: "commands/merge-pr.md",
    invocation: "/merge-pr",
    conductorFlags: Object.freeze([]),
  }),
]);

const MIN_SHA_PREFIX = 7;

const SKIP_CI_RE = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
const SKIP_CHECKS_RE = /^skip-checks:\s*true$/i;

/** A CommonMark fenced-code delimiter: run of >=3 backticks/tildes + info string. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Build a case-insensitive matcher for an exact ATX h2 heading, allowing the
 * CommonMark-legal 0–3 leading spaces and trailing whitespace. Four spaces is
 * an indented code block and must not match.
 *
 * @param {string} text
 * @returns {RegExp}
 */
function h2(text) {
  return new RegExp(`^ {0,3}##[ \\t]+${text}[ \\t]*$`, "im");
}

const RE_SUMMARY = h2("Summary");
const RE_TEST_PLAN = h2("Test plan");

/**
 * Marker the conductor writes into the PR body when `/review-pr --conductor`
 * defers test-plan execution to the `local-attest` phase, and clears once that
 * phase has run the items. While it is present the plan is unverified, which
 * no other gate can detect: `MISSING_TEST_PLAN` only checks for the heading,
 * so "plan present, nothing run" and "plan present, all passed" look alike.
 */
const RE_DEFERRED_TEST_PLAN = /<!--\s*test-plan:\s*deferred\s*-->/i;
const RE_SPEC_ID = h2("Spec ID");
const RE_NO_SPEC = h2("No-spec rationale");

/**
 * Remove fenced code blocks so a body that merely *documents* the PR template
 * cannot satisfy the heading requirements.
 *
 * @param {string} body
 * @returns {string}
 */
function stripFences(body) {
  const out = [];
  /** @type {{char: string, len: number}|null} */
  let open = null;

  for (const line of body.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (open === null) {
      if (m === null) out.push(line);
      else open = { char: m[1][0], len: m[1].length };
      continue;
    }
    // Per CommonMark 4.5 only a run of the SAME character, at least as long as
    // the opener and carrying no info string, closes the block. A naive toggle
    // flips polarity on a nested fence and leaks its contents back out as body
    // text — which would let a PR that merely documents the template pass.
    if (m !== null && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
      open = null;
    }
  }
  return out.join("\n");
}

/**
 * Translate a `docs/repo-facts.json` protected-path glob into a RegExp.
 * Supports `**` (crosses separators), `*` and `?` (do not). Everything else is
 * matched literally — no dependency, per the repo's zero-runtime-deps promise.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * True when two SHAs identify the same commit, tolerating abbreviation in
 * either direction. Prefixes shorter than 7 characters are refused — `gh`
 * never abbreviates that far and a 4-char match would be coincidence.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function shaMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (short.length < MIN_SHA_PREFIX) return false;
  return long.startsWith(short);
}

/**
 * Preconditions for `dotbabel local-attest`. The runner aborts on any of these
 * anyway; checking first turns a 10-minute wasted matrix run into an instant
 * message. Collects every failure rather than short-circuiting so one pass
 * reports all the work to do.
 *
 * @param {{branch?: string, worktreeStatus?: string, localHead?: string,
 *          prHeadOid?: string, prNumber?: number|null}} input
 * @returns {GateResult}
 */
export function checkLocalAttestGate(input = {}) {
  /** @type {GateReason[]} */
  const reasons = [];

  if (input.prNumber === null || input.prNumber === undefined) {
    reasons.push({ code: "NO_PR", message: "no open pull request resolved for this branch" });
  }
  if (input.branch === "HEAD") {
    reasons.push({ code: "DETACHED_HEAD", message: "HEAD is detached; check out the PR branch first" });
  }
  const status = typeof input.worktreeStatus === "string" ? input.worktreeStatus : "";
  if (status.trim() !== "") {
    reasons.push({
      code: "WORKTREE_DIRTY",
      message: "working tree has uncommitted changes",
      detail: status.trim(),
    });
  }
  if (!shaMatches(input.localHead, input.prHeadOid)) {
    const local = String(input.localHead ?? "(none)").slice(0, 8);
    const remote = String(input.prHeadOid ?? "(none)").slice(0, 8);
    reasons.push({
      code: "HEAD_MISMATCH",
      message: `local HEAD ${local} does not match PR head ${remote}`,
    });
  }

  return {
    ok: reasons.length === 0,
    gate: "local-attest",
    reasons,
    hint: reasons.length === 0 ? null : "commit or stash your changes and push before attesting",
  };
}

/**
 * Body and mergeability preconditions enforced downstream by
 * `commands/merge-pr.md` and `skills/review-pr/SKILL.md`. Checking them here
 * means the conductor can fail fast instead of at the merge step.
 *
 * @param {{body?: string|null, hasSpecsDir?: boolean, changedPaths?: string[],
 *          protectedPaths?: string[], mergeable?: string, mergeStateStatus?: string}} input
 * @returns {GateResult}
 */
export function checkMergeGate(input = {}) {
  /** @type {GateReason[]} */
  const reasons = [];
  const raw = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n") : "";

  if (raw.trim() === "") {
    reasons.push({ code: "EMPTY_BODY", message: "PR body is empty" });
  } else {
    const body = stripFences(raw);
    if (!RE_SUMMARY.test(body)) {
      reasons.push({ code: "MISSING_SUMMARY", message: "body must contain an h2 `## Summary` section" });
    }
    if (!RE_TEST_PLAN.test(body)) {
      reasons.push({ code: "MISSING_TEST_PLAN", message: "body must contain an h2 `## Test plan` section" });
    }
    if (RE_DEFERRED_TEST_PLAN.test(body)) {
      reasons.push({
        code: "DEFERRED_TEST_PLAN",
        message: "test plan is deferred to local-attest and has not been cleared",
      });
    }

    const changed = Array.isArray(input.changedPaths) ? input.changedPaths : [];
    const globs = Array.isArray(input.protectedPaths) ? input.protectedPaths : [];
    const hit = changed.find((p) => globs.some((g) => globToRegExp(g).test(p)));
    const specRequired = input.hasSpecsDir === true || hit !== undefined;

    if (specRequired && !RE_SPEC_ID.test(body) && !RE_NO_SPEC.test(body)) {
      reasons.push({
        code: "MISSING_SPEC_ID",
        message: "body must contain `## Spec ID` or `## No-spec rationale`",
        ...(hit === undefined ? {} : { detail: hit }),
      });
    }
  }

  if (input.mergeable === "CONFLICTING") {
    reasons.push({ code: "NOT_MERGEABLE", message: "PR has merge conflicts with its base" });
  }
  if (input.mergeStateStatus === "BEHIND") {
    reasons.push({ code: "BEHIND_BASE", message: "branch is behind its base; rebase before merging" });
  }

  // Criteria evaluation (§5). Every input below is optional, so a caller that
  // passes none gets exactly the pre-P-B3 result.
  const criteria = evaluateCriteria(input);
  /** @type {GateReason[]} */
  const warnings = [...criteria.warnings];
  if (input.criteriaEnforcement === "warn") {
    // `warn` moves the criteria reasons out of the verdict entirely — it does
    // not soften them into a passing reason list, because `reasons` is what
    // callers print as blockers.
    warnings.push(...criteria.blocking);
  } else {
    reasons.push(...criteria.blocking);
  }

  return {
    ok: reasons.length === 0,
    gate: "merge",
    reasons,
    warnings,
    hint: reasons.length === 0 ? null : "see .github/PULL_REQUEST_TEMPLATE.md for the required sections",
  };
}

/**
 * The §5 criteria groups, in order: every spec-level code that holds, then
 * the FIRST evidence code that holds, then the CI code.
 *
 * Evidence stops at the first hit on purpose. The evidence states form a
 * ladder — missing, untrusted, stale, invalid, incomplete, failed — and each
 * rung presupposes the one below it passed. Reporting "stale" beside
 * "untrusted" would describe a comment the gate already refused to believe.
 *
 * @param {any} input
 * @returns {{blocking: GateReason[], warnings: GateReason[]}}
 */
function evaluateCriteria(input) {
  /** @type {GateReason[]} */
  const out = [];
  /** @type {GateReason[]} */
  const warnings = [];
  const required = toCriteriaMap(input.requiredCriteria);
  const base = toCriteriaMap(input.baseActiveCriteria);

  // --- Spec group: reported independently of the evidence ladder. ---
  const unknown = Array.isArray(input.unknownSpecIds) ? input.unknownSpecIds.filter(Boolean) : [];
  if (unknown.length > 0) {
    out.push({
      code: "CRITERIA_SPEC_UNKNOWN",
      message: `body names ${unknown.length === 1 ? "a Spec ID that is" : "Spec IDs that are"} not a spec at the head commit`,
      detail: unknown.join(", "),
    });
  }

  const weakened = [];
  for (const [specId, baseIds] of base) {
    const headIds = required.get(specId) ?? new Set();
    for (const id of baseIds) if (!headIds.has(id)) weakened.push(`${specId}/${id}`);
  }
  if (weakened.length > 0) {
    // A rationale does not make weakening fine; it makes it a reviewed
    // decision, so §5 downgrades the code to a warning — which means it must
    // leave `reasons` entirely, not sit there with a flag and keep blocking.
    const reason = {
      code: "CRITERIA_WEAKENED",
      message: "a criterion active on the base branch is planned or missing at the head",
      detail: weakened.join(", "),
    };
    if (input.criteriaChangeRationale === true) warnings.push({ ...reason, warning: true });
    else out.push(reason);
  }

  const done = () => ({ blocking: withCi(out, input), warnings });

  // --- Evidence group: only when something actually has to be proven. ---
  const requiredTotal = [...required.values()].reduce((n, ids) => n + ids.size, 0);
  if (requiredTotal === 0) return done();

  if (input.comments === null) {
    // REL-3: an unreadable comment list is a failing reason, never a pass.
    // The gate cannot see the evidence, so it refuses rather than assuming
    // the absence of a marker it simply failed to fetch.
    out.push({
      code: "CRITERIA_EVIDENCE_INVALID",
      message: "the evidence comments could not be read",
      detail: "comment fetch failed",
    });
    return done();
  }

  const comments = Array.isArray(input.comments) ? input.comments : [];
  const markerComments = comments.filter((c) => c && typeof c.body === "string" && evidenceMarkerSha(c.body) !== null);
  if (markerComments.length === 0) {
    out.push({
      code: "CRITERIA_EVIDENCE_MISSING",
      message: "linked specs declare active criteria, but no evidence comment carries the marker",
    });
    return done();
  }

  const trustedSet = new Set(
    Array.isArray(input.trustedAssociations) && input.trustedAssociations.length > 0
      ? input.trustedAssociations
      : ["OWNER"],
  );
  // An edited comment is refused outright rather than re-parsed: the marker
  // and payload are what the gate trusts, and an edit means the text it is
  // reading is not the text the tool wrote.
  const trusted = markerComments.filter(
    (c) => trustedSet.has(c.authorAssociation) && (c.lastEditedAt === null || c.lastEditedAt === undefined),
  );
  if (trusted.length === 0) {
    out.push({
      code: "CRITERIA_EVIDENCE_UNTRUSTED",
      message: "no evidence comment has both a trusted author association and no edit",
    });
    return done();
  }

  const headSha = typeof input.headRefOid === "string" ? input.headRefOid : "";
  const current = trusted.filter((c) => evidenceMarkerSha(c.body) === headSha);
  if (current.length === 0) {
    out.push({
      code: "CRITERIA_EVIDENCE_STALE",
      message: "every trusted evidence comment names a commit other than the head",
      detail: `head ${headSha.slice(0, 8)}; evidence ${[...new Set(trusted.map((c) => String(evidenceMarkerSha(c.body)).slice(0, 8)))].join(", ")}`,
    });
    return done();
  }

  // Newest wins: a re-run posts a new comment rather than editing (OPS-4), so
  // the last matching comment is the most recent verdict for this commit.
  const parsed = parseEvidenceComment(current[current.length - 1].body);
  if (parsed.state !== "ok") {
    out.push({
      code: "CRITERIA_EVIDENCE_INVALID",
      message: "the evidence payload could not be read",
      detail: parsed.detail ?? parsed.state,
    });
    return done();
  }
  const problem = evidencePayloadProblem(parsed.payload);
  if (problem !== null) {
    out.push({ code: "CRITERIA_EVIDENCE_INVALID", message: "the evidence payload is not valid", detail: problem });
    return done();
  }

  const covered = payloadCoverage(parsed.payload);
  const gaps = [];
  for (const [specId, ids] of required) {
    const got = covered.get(specId) ?? new Set();
    for (const id of ids) if (!got.has(id)) gaps.push(`${specId}/${id}`);
  }
  if (gaps.length > 0) {
    out.push({
      code: "CRITERIA_EVIDENCE_INCOMPLETE",
      message: "the evidence payload does not cover every active criterion",
      detail: gaps.join(", "),
    });
    return done();
  }

  if (parsed.payload.verdict !== "pass") {
    out.push({
      code: "CRITERIA_FAILED",
      message: `the evidence payload verdict is ${parsed.payload.verdict}`,
    });
  }
  return done();
}

/**
 * @param {GateReason[]} out
 * @param {any} input
 * @returns {GateReason[]}
 */
function withCi(out, input) {
  if (input.requireCiCheck === true && input.ciCriteriaCheck !== "success") {
    out.push({
      code: "CRITERIA_CI_CHECK_FAILED",
      message: `require_ci_check is set and the 'dotbabel criteria' check is ${input.ciCriteriaCheck ?? "absent"}`,
    });
  }
  return out;
}

/**
 * Normalize a `{specId: [ids]}` object or Map into a Map of Sets.
 *
 * @param {unknown} value
 * @returns {Map<string, Set<string>>}
 */
function toCriteriaMap(value) {
  const out = new Map();
  if (value instanceof Map) {
    for (const [k, v] of value) out.set(k, new Set(v ?? []));
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) out.set(k, new Set(Array.isArray(v) ? v : []));
  return out;
}

/**
 * Classify a `[skip ci]`-family marker in a commit message.
 *
 * GitHub Actions matches these markers **anywhere in the message**, so every
 * placement is `effective`. This function used to report a mid-body marker as
 * inert, which was wrong in the dangerous direction: it told a caller CI would
 * run when GitHub had already decided to skip it.
 *
 * Measured on PR #299 — a commit whose message mentioned the marker on its
 * second-to-last line, inside a sentence stating the commit was *not* skipping
 * CI, suppressed all 29 checks. Re-pushing the identical tree with the token
 * absent ran them. `location` is kept for diagnostics only; it no longer
 * changes the verdict.
 *
 * The corollary is a live trap: never write the token in a commit message
 * unless you mean it, not even to talk about it.
 *
 * @param {unknown} commitMessage
 * @returns {SkipCiVerdict}
 */
export function hasSkipCi(commitMessage) {
  /** @type {SkipCiVerdict} */
  const absent = { present: false, marker: null, location: null, effective: false };
  if (typeof commitMessage !== "string" || commitMessage === "") return absent;

  const lines = commitMessage.split("\n");
  const subject = lines[0] ?? "";

  const inSubject = subject.match(SKIP_CI_RE);
  if (inSubject !== null) {
    return { present: true, marker: inSubject[0], location: "subject", effective: true };
  }

  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx].trim() === "") lastIdx -= 1;
  const lastLine = lines[lastIdx] ?? "";

  const inLast = lastLine.match(SKIP_CI_RE);
  if (inLast !== null) {
    return { present: true, marker: inLast[0], location: "last-line", effective: true };
  }
  if (SKIP_CHECKS_RE.test(lastLine.trim())) {
    return { present: true, marker: "skip-checks: true", location: "trailer", effective: true };
  }

  for (const line of lines) {
    const anywhere = line.match(SKIP_CI_RE);
    if (anywhere !== null) {
      return { present: true, marker: anywhere[0], location: "body", effective: true };
    }
  }
  return absent;
}

/**
 * Fold several gate results into one verdict for the go/no-go summary.
 *
 * @param {GateResult[]} results
 * @returns {{ok: boolean, passed: string[], failed: string[], reasonCodes: string[],
 *            count: {total: number, passed: number, failed: number}}}
 */
export function summarizeGates(results) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((r) => r.ok).map((r) => r.gate);
  const failed = list.filter((r) => !r.ok).map((r) => r.gate);
  /** @type {string[]} */
  const reasonCodes = [];
  for (const result of list) {
    for (const reason of result.reasons ?? []) {
      if (!reasonCodes.includes(reason.code)) reasonCodes.push(reason.code);
    }
  }
  return {
    ok: failed.length === 0,
    passed,
    failed,
    reasonCodes,
    count: { total: list.length, passed: passed.length, failed: failed.length },
  };
}
