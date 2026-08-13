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

  return {
    ok: reasons.length === 0,
    gate: "merge",
    reasons,
    hint: reasons.length === 0 ? null : "see .github/PULL_REQUEST_TEMPLATE.md for the required sections",
  };
}

/**
 * Classify a `[skip ci]`-family marker in a commit message.
 *
 * GitHub Actions honors these markers only on the **first or last line** of
 * the message (or as a `skip-checks: true` trailer). A marker buried mid-body
 * is inert — reported as `present` but not `effective`, which is exactly the
 * mistake this function exists to catch.
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
      return { present: true, marker: anywhere[0], location: "body", effective: false };
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
