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
 * @property {GateReason[]} warnings Empty by default; §5 moves criteria
 *   findings here under `enforcement: "warn"`. Every gate returns it, so
 *   `result.warnings.length` is safe without a guard.
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
import {
  ATTEST_MARKER_PREFIX,
  attestationPayloadProblem,
  parseAttestationComment,
  passedLegs,
} from "./attestation.mjs";
import { CRITERIA_MARKER_PREFIX } from "./criteria/comment.mjs";
import { parseEvidenceComment, evidencePayloadProblem, payloadCoverage } from "./criteria/evidence.mjs";
import { createMarker } from "./lib/attest-marker.mjs";
// ARCH-6: one fence stripper, shared with the Spec ID parser. Two copies had
// already drifted — this module required a closing fence to carry no info
// string and the other did not, so a body with ```js inside a ``` block was
// fenced for one gate and not the other.
import { stripFences } from "./lib/spec-ids.mjs";

const criteriaMarker = createMarker(CRITERIA_MARKER_PREFIX);
const attestMarker = createMarker(ATTEST_MARKER_PREFIX);

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
    // Always present, so a caller can read `.warnings` off any gate result
    // without first checking which gate produced it.
    warnings: [],
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

  // Attestation evaluation. Only runs when the BASE ref opted the repository
  // in, so a repository without the policy — including this one, at the commit
  // that introduces the policy — behaves exactly as it did before.
  const attestation = evaluateAttestation(input);
  reasons.push(...attestation);

  return {
    ok: reasons.length === 0,
    gate: "merge",
    reasons,
    warnings,
    // Reported explicitly, because "no ATTESTATION_ reason" is ambiguous: a
    // repository that never opted in produces the same empty list as one whose
    // evidence the gate fully verified. A caller deciding whether it may skip
    // verification must be able to tell those apart without re-reading the base
    // ref itself, and prose is the wrong place to reconstruct it.
    attestation: attestationStatus(input, attestation),
    hint:
      reasons.length === 0
        ? null
        : attestation.length > 0
          ? "re-run `dotbabel local-attest --pr <N>` so the evidence names the current head"
          : "see .github/PULL_REQUEST_TEMPLATE.md for the required sections",
  };
}

/**
 * Summarize the attestation half for a caller that must decide what to run.
 *
 * `off` is a deliberate value, not an absence: it is the bootstrap state, and
 * it means "this gate checked nothing about evidence, verify explicitly". The
 * dangerous misreading is to treat it as `verified`.
 *
 * @param {any} input
 * @param {GateReason[]} reasons Whatever {@link evaluateAttestation} returned.
 * @returns {{state: "verified"|"off"|"failed", sha: string|null, legs: string[], code: string|null}}
 */
function attestationStatus(input, reasons) {
  if (input.attestationEnforced !== true) {
    return { state: "off", sha: null, legs: [], code: null };
  }
  if (reasons.length > 0) {
    return { state: "failed", sha: null, legs: [], code: reasons[0].code };
  }
  const headSha = typeof input.headRefOid === "string" ? input.headRefOid : "";
  const comments = Array.isArray(input.attestationComments) ? input.attestationComments : [];
  const current = comments.filter((c) => c && typeof c.body === "string" && attestMarker.parseSha(c.body) === headSha);
  const parsed = current.length > 0 ? parseAttestationComment(current[current.length - 1].body) : null;
  return {
    state: "verified",
    sha: headSha,
    legs: parsed?.state === "ok" ? [...passedLegs(parsed.payload)] : [],
    code: null,
  };
}

/**
 * The attestation ladder: is there trusted, current, complete evidence that
 * the configured matrix passed at this exact head?
 *
 * Structured exactly like {@link evaluateCriteria}'s evidence group, and for
 * the same reason — the states form a ladder (missing, untrusted, stale,
 * invalid, config-changed, base-moved, incomplete, failed) where each rung
 * presupposes the one below it passed. Reporting "stale" beside "untrusted"
 * would describe a comment the gate already refused to believe, so the first
 * hit wins.
 *
 * Every input is optional. `attestationEnforced` is the switch, and it is read
 * from the base ref by the caller: a pull request cannot turn its own
 * enforcement off, and it cannot turn it on for a trunk that never agreed to
 * it.
 *
 * @param {any} input
 * @returns {GateReason[]}
 */
function evaluateAttestation(input) {
  if (input.attestationEnforced !== true) return [];

  const headSha = typeof input.headRefOid === "string" ? input.headRefOid : "";
  if (headSha === "") {
    return [
      {
        code: "ATTESTATION_INVALID",
        message: "the pull request head SHA could not be read, so no evidence can be matched to it",
      },
    ];
  }

  // REL-21: an unreadable base commit is not "the trunk declares no policy".
  // The gather probes for it and says so, because conflating the two is what
  // turns a missing fetch into a silently disabled gate.
  if (typeof input.attestationBaseUnreadable === "string") {
    return [
      {
        code: "ATTESTATION_BASE_UNREADABLE",
        message: "the base commit is not in this clone, so the attestation policy could not be read",
        detail: `fetch ${input.attestationBaseUnreadable.slice(0, 8)} and re-run`,
      },
    ];
  }

  if (input.attestationComments === null || input.attestationComments === undefined) {
    // REL-3's rule, applied here: the gate cannot see the evidence, so it
    // refuses rather than assuming the absence of a marker it failed to fetch.
    return [
      {
        code: "ATTESTATION_INVALID",
        message: "the attestation comments could not be read",
        detail: "comment fetch failed",
      },
    ];
  }

  const comments = Array.isArray(input.attestationComments) ? input.attestationComments : [];
  const markerComments = comments.filter(
    (c) => c && typeof c.body === "string" && attestMarker.parseSha(c.body) !== null,
  );
  if (markerComments.length === 0) {
    return [
      {
        code: "ATTESTATION_MISSING",
        message: "no local attestation comment exists for this pull request",
        detail: "run `dotbabel local-attest --pr <N>`",
      },
    ];
  }

  const trustedSet = new Set(
    Array.isArray(input.attestationTrustedAssociations) && input.attestationTrustedAssociations.length > 0
      ? input.attestationTrustedAssociations
      : ["OWNER"],
  );
  // An edited comment is refused outright. That is only a meaningful rule
  // because local-attest posts a new comment per run and minimizes the older
  // ones (OPS-4) — under the previous upsert-in-place behaviour every
  // attestation after a pull request's first would land here.
  const trusted = markerComments.filter(
    (c) => trustedSet.has(c.authorAssociation) && (c.lastEditedAt === null || c.lastEditedAt === undefined),
  );
  if (trusted.length === 0) {
    return [
      {
        code: "ATTESTATION_UNTRUSTED",
        message: "no attestation comment has both a trusted author association and no edit",
      },
    ];
  }

  const current = trusted.filter((c) => attestMarker.parseSha(c.body) === headSha);
  if (current.length === 0) {
    const seen = [...new Set(trusted.map((c) => String(attestMarker.parseSha(c.body)).slice(0, 8)))];
    return [
      {
        code: "ATTESTATION_STALE",
        message: "every trusted attestation names a commit other than the head",
        detail: `attested ${seen.join(", ")}; current ${headSha.slice(0, 8)}`,
      },
    ];
  }

  // Newest wins, as with criteria: a re-run posts rather than edits, so the
  // last matching comment is the most recent verdict for this commit.
  const parsed = parseAttestationComment(current[current.length - 1].body);
  if (parsed.state === "no-payload") {
    return [
      {
        code: "ATTESTATION_INVALID",
        message: "the attestation carries no evidence payload",
        detail: "it was written by a dotbabel version that predates the payload; re-run local-attest",
      },
    ];
  }
  if (parsed.state !== "ok") {
    return [
      {
        code: "ATTESTATION_INVALID",
        message: "the attestation payload could not be read",
        detail: parsed.detail ?? parsed.state,
      },
    ];
  }
  const problem = attestationPayloadProblem(parsed.payload);
  if (problem !== null) {
    return [{ code: "ATTESTATION_INVALID", message: "the attestation payload is not valid", detail: problem }];
  }

  // The configuration check. Without it the leg list proves only that legs
  // named `test` and `quality` ran, not that they ran anything.
  const expectedHash = typeof input.expectedConfigHash === "string" ? input.expectedConfigHash : null;
  if (expectedHash !== null && parsed.payload.config_hash !== expectedHash) {
    return [
      {
        code: "ATTESTATION_CONFIG_CHANGED",
        message: "the attestation was produced under a different local-attest configuration than the base branch",
        detail:
          parsed.payload.config_hash === undefined
            ? "the payload records no config_hash"
            : "this pull request changes a governed file, so its own attestation cannot authorize it",
      },
    ];
  }

  const expectedMergeBase = typeof input.expectedMergeBase === "string" ? input.expectedMergeBase : null;
  if (expectedMergeBase !== null) {
    // An absent `merge_base` blocks rather than skipping the rung, mirroring
    // `config_hash` above. The producer omits the field whenever the base was
    // unfetched, so treating absence as "nothing to check" let an ordinary
    // environment glitch hand over evidence that graded a different diff.
    if (typeof parsed.payload.merge_base !== "string") {
      return [
        {
          code: "ATTESTATION_INVALID",
          message: "the attestation records no merge base, so the diff it graded cannot be confirmed",
          detail: "re-run local-attest with the base branch fetched",
        },
      ];
    }
    if (!shaMatches(parsed.payload.merge_base, expectedMergeBase)) {
      return [
        {
          code: "ATTESTATION_BASE_MOVED",
          message: "the attestation graded a different diff than the one being merged",
          detail: `attested against ${String(parsed.payload.merge_base).slice(0, 8)}; current merge base ${expectedMergeBase.slice(0, 8)}`,
        },
      ];
    }
  }

  const required = Array.isArray(input.requiredLegs) ? input.requiredLegs.filter(Boolean) : [];
  if (required.length > 0) {
    const passed = passedLegs(parsed.payload);
    const missing = required.filter((name) => !passed.has(name));
    if (missing.length > 0) {
      return [
        {
          code: "ATTESTATION_INCOMPLETE",
          message: "the attestation does not show every required check passing",
          detail: missing.join(", "),
        },
      ];
    }
  }

  if (parsed.payload.verdict !== "pass") {
    return [{ code: "ATTESTATION_FAILED", message: `the attestation verdict is ${parsed.payload.verdict}` }];
  }
  return [];
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

  const pathScoped = new Set(Array.isArray(input.pathScopedSpecIds) ? input.pathScopedSpecIds : []);
  const weakened = [];
  // Weakening a spec the DIFF pulled into scope is not a reviewable decision:
  // the author would be deleting or planning away the very criteria that
  // govern the files they are changing, which is the #367 bypass reached
  // through the head instead of the body. Those stay blocking.
  const weakenedInScope = [];
  for (const [specId, baseIds] of base) {
    const headIds = required.get(specId) ?? new Set();
    for (const id of baseIds) {
      if (headIds.has(id)) continue;
      (pathScoped.has(specId) ? weakenedInScope : weakened).push(`${specId}/${id}`);
    }
  }
  if (weakenedInScope.length > 0) {
    out.push({
      code: "CRITERIA_SCOPE_WEAKENED",
      message: "a criterion governing the changed files is planned or missing at the head",
      detail: weakenedInScope.join(", "),
    });
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

  // REL-19: scope is derived from the changed-file list, so a list that could
  // not be shown complete leaves the gate unable to know what governs the diff.
  if (input.criteriaFilesUnreadable === true) {
    out.push({
      code: "CRITERIA_FILES_UNREADABLE",
      message: "the pull request's changed-file list could not be read in full, so criteria scope is unknown",
    });
    return done();
  }

  // REL-3: the base ref defines the rules. If it could not be read, the gate
  // has no rules to apply and must say so rather than apply the defaults,
  // which would silently relax both the weakening check and require_ci_check.
  if (typeof input.criteriaBaseUnreadable === "string") {
    out.push({
      code: "CRITERIA_BASE_UNREADABLE",
      message: "the base commit is not in this clone, so the criteria rules could not be read",
      detail: `fetch ${String(input.criteriaBaseUnreadable).slice(0, 8)} and re-run`,
    });
    return done();
  }

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
  const markerComments = comments.filter((c) => c && typeof c.body === "string" && criteriaMarker.parseSha(c.body) !== null);
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
  const current = trusted.filter((c) => criteriaMarker.parseSha(c.body) === headSha);
  if (current.length === 0) {
    out.push({
      code: "CRITERIA_EVIDENCE_STALE",
      message: "every trusted evidence comment names a commit other than the head",
      detail: `head ${headSha.slice(0, 8)}; evidence ${[...new Set(trusted.map((c) => String(criteriaMarker.parseSha(c.body)).slice(0, 8)))].join(", ")}`,
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
