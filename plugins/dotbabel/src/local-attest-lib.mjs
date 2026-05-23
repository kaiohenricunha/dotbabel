/**
 * local-attest-lib — pure helpers for the local CI attestation skill.
 *
 * Every export here is deterministic and free of I/O so the test suite can
 * exercise them without stubs. The CI gate semantics depend on these helpers
 * being byte-exact: the marker must appear on the first line of the rendered
 * comment, and only OWNER-class authors are trusted by default.
 *
 * @typedef {object} Comment
 * @property {number|string} [id]
 * @property {string} author_association
 * @property {string} body
 *
 * @typedef {"hard"|"advisory"} LegMode
 *
 * @typedef {object} LegResult
 * @property {string} name
 * @property {LegMode} mode
 * @property {boolean} passed
 * @property {number} durationS
 * @property {string} tail
 *
 * @typedef {object} ParsedArgs
 * @property {string|null} pr
 * @property {boolean} push
 * @property {boolean} dryRun
 * @property {string|null} config
 * @property {boolean} help
 */

export const ATTEST_MARKER_PREFIX = "<!-- local-attest verified-sha=";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Build the hidden marker the CI gate greps for. Throws on a non-SHA so a
 * malformed value can never produce a marker that silently never matches.
 *
 * @param {string} sha
 * @returns {string}
 */
export function buildAttestMarker(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error(`invalid sha: ${JSON.stringify(sha)}`);
  }
  return `${ATTEST_MARKER_PREFIX}${sha} -->`;
}

/**
 * True iff a comment from a trusted author attests this exact head SHA.
 * Trust is determined by `trustedAssociations` (default `["OWNER"]`) — a
 * non-trusted user cannot forge a skip by commenting the marker.
 *
 * @param {Comment[]} comments
 * @param {string} headSha
 * @param {{ trustedAssociations?: string[] }} [opts]
 * @returns {boolean}
 */
export function isAttested(comments, headSha, opts = {}) {
  if (!Array.isArray(comments) || typeof headSha !== "string" || headSha === "") {
    return false;
  }
  let marker;
  try {
    marker = buildAttestMarker(headSha);
  } catch {
    return false;
  }
  const trusted = new Set(opts.trustedAssociations ?? ["OWNER"]);
  return comments.some(
    (c) =>
      c &&
      trusted.has(c.author_association) &&
      typeof c.body === "string" &&
      c.body.split("\n")[0] === marker,
  );
}

/**
 * Find any existing local-attest comment (any SHA, any author) so the
 * caller can update it in place instead of posting a duplicate.
 *
 * @param {Comment[]} comments
 * @returns {Comment|null}
 */
export function findAttestComment(comments) {
  if (!Array.isArray(comments)) return null;
  return (
    comments.find(
      (c) => c && typeof c.body === "string" && c.body.includes(ATTEST_MARKER_PREFIX),
    ) ?? null
  );
}

/**
 * Parse CLI argv. Exits via `die` on usage errors so the caller can wrap
 * with the harness exit codes.
 *
 * @param {string[]} argv
 * @param {(code: number, msg: string) => void} [die]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, die) {
  const exit =
    die ??
    ((code, msg) => {
      const err = new Error(msg);
      /** @type {any} */ (err).code = "USAGE";
      /** @type {any} */ (err).exitCode = code;
      throw err;
    });
  /** @type {ParsedArgs} */
  const args = { pr: null, push: true, dryRun: false, config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v)) return exit(64, `--pr requires a number, got ${v ?? "(missing)"}`);
      args.pr = v;
    } else if (a === "--no-push") {
      args.push = false;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--config") {
      const v = argv[++i];
      if (!v) return exit(64, "--config requires a path");
      args.config = v;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      return exit(64, `unknown argument: ${a}`);
    }
  }
  return args;
}

/**
 * Return the last `n` lines of `text`, trimming trailing whitespace.
 *
 * @param {string} text
 * @param {number} [n]
 * @returns {string}
 */
export function tail(text, n = 10) {
  const lines = String(text ?? "")
    .replace(/\s+$/, "")
    .split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Render the attestation comment body. The marker is guaranteed to be line 1 —
 * the CI gate matches only the first line of each comment.
 *
 * @param {LegResult[]} results
 * @param {{ headSha: string, hostname: string, now?: Date }} ctx
 * @returns {string}
 */
export function renderComment(results, { headSha, hostname, now }) {
  const marker = buildAttestMarker(headSha);
  const ts = (now ?? new Date()).toISOString();
  const rows = results
    .map((r) => {
      const status = r.passed ? "pass" : r.mode === "advisory" ? "fail (advisory)" : "FAIL";
      return `| ${r.name} | ${r.mode} | ${status} | ${r.durationS}s |`;
    })
    .join("\n");
  return [
    marker,
    "## Local Attestation",
    "",
    `The full CI check matrix ran locally and the hard legs passed for \`${headSha.slice(0, 8)}\`.`,
    "Test and Preview will skip for this commit. A new push re-runs CI automatically.",
    "",
    "| Check | Mode | Result | Duration |",
    "|---|---|---|---|",
    rows,
    "",
    `- Host: \`${hostname}\``,
    `- Attested at: \`${ts}\``,
    `- Verified SHA: \`${headSha}\``,
  ].join("\n");
}

/**
 * Shape one JSONL line for the audit log.
 *
 * @param {{ pr: number|string, sha: string, hostname: string, advisoryFails: string[], now?: Date }} input
 * @returns {{ ts: string, pr: number, sha: string, host: string, advisoryFails: string[] }}
 */
export function buildAuditEntry({ pr, sha, hostname, advisoryFails, now }) {
  return {
    ts: (now ?? new Date()).toISOString(),
    pr: Number(pr),
    sha,
    host: hostname,
    advisoryFails: [...advisoryFails],
  };
}

/**
 * Summarize a matrix run.
 *
 * @param {LegResult[]} results
 * @returns {{ hardFails: LegResult[], advisoryFails: LegResult[], totalDurationS: number }}
 */
export function summarizeResults(results) {
  const hardFails = results.filter((r) => r.mode === "hard" && !r.passed);
  const advisoryFails = results.filter((r) => r.mode === "advisory" && !r.passed);
  const totalDurationS = results.reduce((acc, r) => acc + (r.durationS ?? 0), 0);
  return { hardFails, advisoryFails, totalDurationS };
}

/**
 * Build the workflow gate snippet for `test.yml` / `preview.yml`. Substitutes
 * the configured trust list into the jq `select(...)` clause so a project that
 * trusts MEMBERs as well as OWNERs gets a snippet that matches its config.
 *
 * @param {{ trustedAssociations?: string[] }} [opts]
 * @returns {string}
 */
export function buildGateSnippet(opts = {}) {
  const trusted = opts.trustedAssociations ?? ["OWNER"];
  if (!Array.isArray(trusted) || trusted.length === 0) {
    throw new Error("buildGateSnippet: trustedAssociations must be a non-empty array");
  }
  const select =
    trusted.length === 1
      ? `select(.author_association == "${trusted[0]}")`
      : `select(${trusted.map((t) => `.author_association == "${t}"`).join(" or ")})`;
  return [
    `      - name: Check for local attestation`,
    `        if: github.event_name == 'pull_request'`,
    `        env:`,
    `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    `          REPO: \${{ github.repository }}`,
    `          PR_NUMBER: \${{ github.event.pull_request.number }}`,
    `          HEAD_SHA: \${{ github.event.pull_request.head.sha }}`,
    `        run: |`,
    `          MARKER="<!-- local-attest verified-sha=\${HEAD_SHA} -->"`,
    `          if gh api "repos/\${REPO}/issues/\${PR_NUMBER}/comments" --paginate \\`,
    `               --jq '.[] | ${select} | .body | split("\\n")[0]' \\`,
    `             | grep -qF "$MARKER"; then`,
    `            echo "attested=true" >> "$GITHUB_OUTPUT"`,
    `          else`,
    `            echo "attested=false" >> "$GITHUB_OUTPUT"`,
    `          fi`,
  ].join("\n");
}
