/**
 * Structured error normalization for remote handoff transport failures.
 *
 * Every remote failure is normalized to {stage, cause, fix, retry} so users
 * see an actionable block instead of raw git/script stderr.
 *
 * Stages: preflight | resolve | scrub | upload | cleanup
 */

/**
 * Sentinel thrown by autoPreflight when the doctor script fails.
 * The doctor already wrote its remediation block to stderr, so callers
 * must NOT emit a second structured block for this error.
 */
export class PreflightHandledError extends Error {}

/**
 * Structured error for remote handoff transport failures.
 * Carries four actionable fields rendered by {@link formatHandoffError}.
 */
export class HandoffError extends Error {
  /**
   * @param {{stage: string, cause: string, fix: string, retry: string}} fields
   */
  constructor({ stage, cause, fix, retry }) {
    super(cause);
    this.stage = stage;
    this.cause = cause;
    this.fix = fix;
    this.retry = retry;
  }
}

/** Pattern → {stage, cause, fix} mapping, evaluated in order. */
const PATTERNS = [
  {
    re: /Permission denied \(publickey\)/i,
    stage: "upload",
    cause: "SSH key not configured",
    fix: "Add your SSH key or switch to HTTPS: https://docs.github.com/en/authentication",
  },
  {
    re: /Authentication failed/i,
    stage: "upload",
    cause: "authentication failed",
    fix: "Re-authenticate: run `git credential reject` or `gh auth login`",
  },
  {
    re: /repository not found|project.*could not be found|does not appear to be a git repository/i,
    stage: "preflight",
    cause: "transport repo not found",
    fix: "Reconfigure DOTCLAUDE_HANDOFF_REPO or run `dotbabel handoff push` to re-bootstrap",
  },
  {
    re: /Could not resolve host/i,
    stage: "upload",
    cause: "network unreachable",
    fix: "Check your network connection",
  },
  {
    re: /unable to access/i,
    stage: "upload",
    cause: "transport unreachable",
    fix: "Check your network connection and credentials",
  },
  {
    re: /failed to push/i,
    stage: "upload",
    cause: "push rejected",
    fix: "Check write access to the transport repo",
  },
  {
    re: /scrub not applied/i,
    stage: "scrub",
    cause: "scrubber unavailable",
    fix: "Reinstall dotbabel: `npm install -g @dotbabel/dotbabel`",
  },
  {
    re: /DOTCLAUDE_HANDOFF_REPO is not set/i,
    stage: "preflight",
    cause: "transport not configured",
    fix: "Run `dotbabel handoff push` to auto-bootstrap, or set DOTCLAUDE_HANDOFF_REPO manually",
  },
  {
    re: /ls-remote failed/i,
    stage: "preflight",
    cause: "repo unreachable",
    fix: "Run `dotbabel handoff doctor` to diagnose",
  },
  {
    re: /no handoffs? found/i,
    stage: "resolve",
    cause: "no handoffs on transport",
    fix: "Push a session first: `dotbabel handoff push`",
  },
  {
    re: /no .+ handoffs? match:|no handoffs? match:/i,
    stage: "resolve",
    cause: "query matched nothing on transport",
    fix: "Run `dotbabel handoff remote-list` to see what's available",
  },
];

/**
 * Classify a raw error message string into a HandoffError.
 * Falls back to stage=upload with the raw message as cause.
 *
 * @param {string} rawMsg
 * @param {string} verb  "push" | "fetch"
 * @param {{query?: string, shortId?: string}} context
 * @returns {HandoffError}
 */
export function classifyGitError(rawMsg, verb, context = {}) {
  const { query, shortId } = context;
  const retryArg = query ?? shortId ?? null;
  const retryLine = retryArg
    ? `dotbabel handoff ${verb} ${retryArg}`
    : `dotbabel handoff ${verb}`;

  for (const { re, stage, cause, fix } of PATTERNS) {
    if (re.test(rawMsg)) {
      return new HandoffError({ stage, cause, fix, retry: retryLine });
    }
  }

  // Unknown failure: surface raw message so nothing is hidden.
  return new HandoffError({
    stage: "upload",
    cause: rawMsg,
    fix: "Run `dotbabel handoff doctor` to diagnose",
    retry: retryLine,
  });
}

/**
 * Format a HandoffError into the structured stderr block.
 * Returns the formatted string (does NOT write to stderr itself —
 * the caller controls the output destination).
 *
 * @param {HandoffError} err
 * @param {string} verb  "push" | "fetch"
 * @returns {string}
 */
export function formatHandoffError(err, verb) {
  const clean = (s) => (s ?? "").replace(/\r?\n/g, " ").trim();
  return [
    `dotbabel-handoff: ${verb} failed`,
    `  stage:  ${clean(err.stage)}`,
    `  cause:  ${clean(err.cause)}`,
    `  fix:    ${clean(err.fix)}`,
    `  retry:  ${clean(err.retry)}`,
    "",
  ].join("\n");
}
