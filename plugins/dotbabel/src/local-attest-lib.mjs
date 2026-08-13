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
 * @property {boolean} [notRun]  true when fail-fast stopped the run before this leg launched;
 *                               `passed` is false so a consumer that forgets to check errs
 *                               toward reporting failure, never success
 * @property {number} durationS
 * @property {string} tail
 *
 * @typedef {object} ParsedArgs
 * @property {string|null} pr
 * @property {boolean} push
 * @property {boolean} dryRun
 * @property {string|null} config
 * @property {boolean} help
 * @property {string[]} only
 * @property {string|null} from
 * @property {boolean} failFast
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
  const args = {
    pr: null,
    push: true,
    dryRun: false,
    config: null,
    help: false,
    only: [],
    from: null,
    failFast: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v))
        return exit(64, `--pr requires a number, got ${v ?? "(missing)"}`);
      args.pr = v;
    } else if (a === "--no-push") {
      args.push = false;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--config") {
      const v = argv[++i];
      if (!v) return exit(64, "--config requires a path");
      args.config = v;
    } else if (a === "--only") {
      const v = argv[++i];
      if (!v) return exit(64, "--only requires a leg name");
      args.only.push(v);
    } else if (a === "--from") {
      const v = argv[++i];
      if (!v) return exit(64, "--from requires a leg name");
      if (args.from !== null) return exit(64, "--from given more than once");
      args.from = v;
    } else if (a === "--fail-fast") {
      args.failFast = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      return exit(64, `unknown argument: ${a}`);
    }
  }
  if (args.only.length > 0 && args.from !== null) {
    return exit(64, "--only and --from are mutually exclusive — pick one");
  }
  return args;
}

/**
 * Select a subset of the matrix for a diagnostic run.
 *
 * `only` entries match leg names exactly and case-sensitively. A token that is
 * not itself a leg name is split on commas — the order matters, because a leg
 * name may legitimately contain a comma and must never be split apart. The
 * selection preserves matrix order regardless of the order names were given,
 * because the declared order is the only order the operator ever sees.
 *
 * `from` selects the suffix starting at the named leg's index.
 *
 * Unknown names throw with every valid name listed, so the fix is a copy-paste
 * rather than a guessing game. No dependency injection happens: `--from` and
 * `--only` run exactly what they name, which is precisely why a subset run can
 * never attest (see {@link shouldAttest}).
 *
 * @param {Array<{name: string}>} matrix
 * @param {{ only?: string[], from?: string|null }} sel
 * @returns {Array<{name: string}>}
 */
export function filterMatrix(matrix, { only = [], from = null } = {}) {
  const names = matrix.map((l) => l.name);
  const unknown = (name) => {
    const err = new Error(
      `unknown leg ${JSON.stringify(name)} — valid legs:\n  ${names.join("\n  ")}`,
    );
    /** @type {any} */ (err).code = "USAGE";
    /** @type {any} */ (err).exitCode = 64;
    return err;
  };

  if (from !== null) {
    const idx = names.indexOf(from);
    if (idx === -1) throw unknown(from);
    return matrix.slice(idx);
  }

  if (only.length > 0) {
    const wanted = new Set();
    for (const token of only) {
      if (names.includes(token)) {
        wanted.add(token);
        continue;
      }
      for (const part of token
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (!names.includes(part)) throw unknown(part);
        wanted.add(part);
      }
    }
    return matrix.filter((l) => wanted.has(l.name));
  }

  return matrix;
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
  const LABELS = {
    pass: "pass",
    fail: "FAIL",
    "advisory-fail": "fail (advisory)",
    // Unreachable when shouldAttest gates posting, but a future wiring bug
    // must surface as "not run" — never as a pass.
    "not-run": "not run (fail-fast)",
  };
  const rows = results
    .map((r) => `| ${r.name} | ${r.mode} | ${LABELS[legStatus(r)]} | ${r.durationS}s |`)
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
 * Classify one leg result into its terminal status. The summary printer, the
 * comment renderer, and the audit entry all derive their labels from this one
 * function, so the three surfaces cannot disagree about what happened.
 *
 * An absent record classifies as `not-run`: it was never executed, and saying
 * so is the honest reading of a hole.
 *
 * @param {LegResult|undefined} r
 * @returns {"pass"|"fail"|"advisory-fail"|"not-run"}
 */
export function legStatus(r) {
  if (!r || r.notRun) return "not-run";
  if (r.passed) return "pass";
  return r.mode === "advisory" ? "advisory-fail" : "fail";
}

/**
 * The mechanical attestation bar. Posting, labelling, and pushing are only
 * reachable when this returns true — a prose promise that "partial runs never
 * attest" is exactly the kind of obligation that drifts, so the run record
 * itself is judged instead.
 *
 * The flag check and the structural checks are deliberately redundant: with
 * `diagnostic` false a `notRun` entry "cannot" exist, but the structural
 * clauses catch the future wiring bug that makes it exist anyway.
 *
 * Advisory failures do not block, matching the gate semantics the matrix
 * mirrors. A `--fail-fast` run in which nothing failed completed the full
 * matrix and may attest.
 *
 * @param {{ diagnostic?: boolean, results: Array<LegResult|undefined> }} run
 * @returns {boolean}
 */
export function shouldAttest({ diagnostic, results }) {
  return (
    diagnostic !== true &&
    Array.isArray(results) &&
    results.length > 0 &&
    results.every((r) => r && r.notRun !== true && typeof r.passed === "boolean") &&
    !results.some((r) => r && r.mode === "hard" && !r.passed)
  );
}

/**
 * Shape one JSONL line for the audit log.
 *
 * Every legacy field (`ts`, `pr`, `sha`, `host`, `advisoryFails`) keeps its
 * exact shape: lines written before `result` existed were only ever written
 * after a successful post, so a reader may treat a missing `result` as
 * `"attested"`. New fields are additive:
 *
 * - `result` — what the run concluded: attested | hard-fail | head-moved |
 *   push-fail | post-fail | dry-run | diagnostic.
 * - `legs` — per-leg terminal status and duration, via {@link legStatus}.
 *   This is what makes failure distributions measurable at all.
 * - `flags` — the invocation shape, so diagnostic lines are interpretable.
 * - `dirty` — diagnostic runs only: a dirty tree's `sha` does not identify
 *   the tree that ran, and the record says so.
 *
 * @param {{ result: string, pr: number|string|null, sha: string|null, hostname: string,
 *           advisoryFails: string[], results?: Array<LegResult|undefined>,
 *           flags?: { only?: string[], from?: string|null, failFast?: boolean, push?: boolean },
 *           dirty?: boolean, now?: Date }} input
 * @returns {object}
 */
export function buildAuditEntry({
  result,
  pr,
  sha,
  hostname,
  advisoryFails,
  results,
  flags,
  dirty,
  now,
}) {
  const entry = {
    ts: (now ?? new Date()).toISOString(),
    pr: pr == null ? null : Number(pr),
    sha: sha ?? null,
    host: hostname,
    advisoryFails: [...advisoryFails],
    result,
  };
  if (Array.isArray(results)) {
    entry.legs = results.map((r) => ({
      name: r?.name ?? "(unknown)",
      mode: r?.mode ?? "hard",
      status: legStatus(r),
      durationS: r?.durationS ?? 0,
    }));
  }
  if (flags) {
    entry.flags = {
      only: [...(flags.only ?? [])],
      from: flags.from ?? null,
      failFast: flags.failFast === true,
      push: flags.push !== false,
    };
  }
  if (dirty !== undefined) entry.dirty = dirty;
  return entry;
}

/**
 * Summarize a matrix run. Not-run legs count as neither failure class — they
 * were never executed, and counting them as failures would misreport a
 * fail-fast stop as a pile of breakage.
 *
 * @param {LegResult[]} results
 * @returns {{ hardFails: LegResult[], advisoryFails: LegResult[], totalDurationS: number }}
 */
export function summarizeResults(results) {
  const hardFails = results.filter((r) => !r.notRun && r.mode === "hard" && !r.passed);
  const advisoryFails = results.filter((r) => !r.notRun && r.mode === "advisory" && !r.passed);
  const totalDurationS = results.reduce((acc, r) => acc + (r.durationS ?? 0), 0);
  return { hardFails, advisoryFails, totalDurationS };
}

// ---------------------------------------------------------------------------
// Toolchain pins — config-declared, checked before a run
// ---------------------------------------------------------------------------

/**
 * Major version out of an engines-style pin: "22", "22.x", ">=22", "^22.1.0".
 * Null when no major can be read.
 *
 * @param {unknown} pin
 * @returns {number|null}
 */
export function nodeMajorFromPin(pin) {
  const m = /^[^\d]*(\d+)/.exec(String(pin ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Major version out of a runtime version string ("22.11.0").
 *
 * @param {unknown} version
 * @returns {number|null}
 */
export function nodeMajorOf(version) {
  const m = /^(\d+)/.exec(String(version ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * "major.minor" out of `go version` output ("go version go1.26.5 linux/amd64").
 *
 * @param {unknown} output
 * @returns {string|null}
 */
export function goMajorMinorFromVersion(output) {
  const m = /\bgo(\d+)\.(\d+)/.exec(String(output ?? ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * "major.minor" out of a go.mod `go` directive ("go 1.26.5").
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function goMajorMinorFromGoMod(text) {
  const m = /^go\s+(\d+)\.(\d+)/m.exec(String(text ?? ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Compare the running toolchain against the config's pins. Returns one
 * human-readable problem per mismatch. Unparseable versions count as
 * problems — the attestation certifies "CI would pass", and a toolchain
 * nobody can identify certifies nothing (fail-closed).
 *
 * No pin, no problems: the check is opt-in per config.
 *
 * @param {{ pin?: { node?: string, goMod?: string }|null, nodeVersion?: string,
 *           goVersionOutput?: string, goModText?: string }} input
 * @returns {string[]}
 */
export function toolchainProblems({ pin, nodeVersion, goVersionOutput, goModText }) {
  if (!pin) return [];
  const problems = [];
  if (pin.node !== undefined) {
    const want = nodeMajorFromPin(pin.node);
    const have = nodeMajorOf(nodeVersion);
    if (want === null || have === null) {
      problems.push(
        `cannot compare Node versions (running: ${have ?? "unparseable"}, pin: ${want ?? "unparseable"})`,
      );
    } else if (want !== have) {
      problems.push(`Node ${have} is running but config.toolchain.node pins ${pin.node}`);
    }
  }
  if (pin.goMod !== undefined) {
    const want = goMajorMinorFromGoMod(goModText);
    const have = goMajorMinorFromVersion(goVersionOutput);
    if (want === null || have === null) {
      problems.push(
        `cannot compare Go versions (go version: ${have ?? "unparseable"}, ${pin.goMod}: ${want ?? "unparseable"})`,
      );
    } else if (want !== have) {
      problems.push(`Go ${have} is on PATH but ${pin.goMod} pins ${want}`);
    }
  }
  return problems;
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
  const select = `select(${trusted.map((t) => `.author_association == "${t}"`).join(" or ")})`;
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
    `             | grep -qFx "$MARKER"; then`,
    `            echo "attested=true" >> "$GITHUB_OUTPUT"`,
    `          else`,
    `            echo "attested=false" >> "$GITHUB_OUTPUT"`,
    `          fi`,
  ].join("\n");
}
