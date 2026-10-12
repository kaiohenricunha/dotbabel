// Pure helpers shared by extract.mjs, replay.mjs and analyze.mjs. Nothing here
// does I/O except sendAll, which takes its fetch as an argument so the tests
// can drive it without a network.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

// skills/post-pr-review/references/agent-contract.md
export const CATEGORIES = Object.freeze([
  "bug",
  "style",
  "test",
  "comment",
  "type",
  "simplify",
  "error-handling",
  "security",
  "design",
]);
export const SEVERITIES = Object.freeze(["suggestion", "important", "critical"]);

// skills/review-pr/SKILL.md step 3: under --conductor these categories take the
// fast path and are never validated, so their verdict is not an independent
// judgment and they stay out of the primary set. A finding whose category the
// comment does not state cannot take the fast path, so it stays in.
export const MECHANICAL = Object.freeze(new Set(["style", "comment", "type"]));

const MARKER = /<!--\s*post-pr-review:v1:([0-9a-f]{16})\s*-->/;
const SEVERITY_WORD = /\b(critical|important|suggestion)\b/i;
const AGENT_WORD = /\b([a-z]+(?:-[a-z]+)*-(?:reviewer|auditor|writer|engineer|specialist|developer))\b/;
const CATEGORY_LABEL = new RegExp(`\\bcategory:?\\s*\`?(${CATEGORIES.join("|")})\`?`, "i");
// A metadata line: `<sub>agent · category: x · confidence: 84</sub>` or
// `Category: \`test\` · Agent: \`x\` · Confidence: 93`.
const META_LINE = /^\s*(<sub>|_?via\b|\(?confidence\b|(category|agent|severity)\s*:)/i;
const CATEGORY_PAREN = new RegExp(`\\((${CATEGORIES.join("|")})\\)`, "i");
const HEADING = /^#{1,6}\s+(.+)$/;

// An underscore is emphasis only at a word edge; inside `high_confidence` it is
// part of the identifier and stays.
const stripMarkup = (s) =>
  s
    .replace(/[*`[\]]/g, "")
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .trim();

/**
 * Parse one posted /post-pr-review finding.
 *
 * The agent contract fixes the fields, not the rendering, and the rendering
 * changed across this repository's history: `**[important] title** · _agent_ ·
 * category`, `**suggestion** · \`design\` · _agent_`, a `<sub>` metadata
 * line, and others. So the fields are read from the header line and any
 * metadata line by keyword, and a field that is absent comes back `unknown`.
 * The returned title and body carry none of the severity, category, or agent
 * tokens: replay.mjs asks Jev to predict those.
 *
 * Returns null when the comment carries no marker.
 */
export function parseFinding(body) {
  if (typeof body !== "string") return null;
  const marker = body.match(MARKER);
  if (!marker) return null;

  const lines = body.replace(MARKER, "").trim().split("\n");
  const header = lines[0] ?? "";
  const metaLines = lines.slice(1).filter((l) => META_LINE.test(l));
  // Underscores and backticks are markup here, and `_agent_` would hide the
  // agent from a word-boundary match, so the fields are read from plain text.
  const region = [header, ...metaLines].join("\n").replace(/[*_`[\]]/g, " ");

  const severity = (region.match(SEVERITY_WORD)?.[1] ?? "unknown").toLowerCase();
  const agent = region.match(AGENT_WORD)?.[1] ?? "unknown";
  let category = (region.match(CATEGORY_LABEL)?.[1] ?? region.match(CATEGORY_PAREN)?.[1])?.toLowerCase();
  if (!category) {
    // `**suggestion** · \`design\` · _agent_` and `… · _agent_ · design`: a
    // separator-delimited segment that is exactly a category name.
    const segments = header.split(/\s[·—|]\s/).map((s) => stripMarkup(s).toLowerCase());
    category = segments.find((s) => CATEGORIES.includes(s)) ?? "unknown";
  }

  const scrub = (s) => {
    let t = stripMarkup(s)
      .replace(new RegExp(`\\b${severity}\\b`, "i"), "")
      .replace(new RegExp(AGENT_WORD.source, "g"), "")
      .replace(/\(?\bconfidence:?\s*\d+\)?\.?/gi, "");
    for (const seg of t.split(/\s[·—|]\s/)) {
      if (seg.trim().toLowerCase() === category) t = t.replace(seg, "");
    }
    return t
      .replace(/\s\+\s/g, " ")
      .replace(/^[\s·—|:.+-]+|[\s·—|:.+-]+$/g, "")
      .replace(/\s+[·|]\s+(?=[·|]|$)/g, "")
      .trim();
  };

  let rest = lines.slice(1).filter((l) => !META_LINE.test(l));
  let title = scrub(header);
  if (title.length < 8) {
    const i = rest.findIndex((l) => HEADING.test(l));
    if (i !== -1) {
      title = scrub(rest[i].match(HEADING)[1]);
      rest = rest.filter((_, j) => j !== i);
    }
  }
  return { finding_id: marker[1], severity, title, agent, category, body: rest.join("\n").trim() };
}

// Ordered: the first rule that matches the start of the first reply decides.
// `deferred` counts as valid: the reply agrees the defect is real and only
// postpones the fix. `partial` and anything unmatched stay unknown.
const VERDICT_RULES = [
  ["false_positive", "false-positive", /^false positive\b/i],
  ["false_positive", "not-an-issue", /^not (an issue|a bug|a defect|a problem|applicable)\b/i],
  ["false_positive", "intentional", /^intentional\b/i],
  ["false_positive", "declined", /^declin(ed|ing)\b/i],
  ["false_positive", "already-exists", /^note:[^\n]*\balready (exist|covered|handled|present)/i],
  ["false_positive", "not-to-fix", /^this (one )?(isn't|is not) something to fix\b/i],
  ["false_positive", "intentional", /^deliberate\b/i],
  ["false_positive", "kept-as-is", /^kept (as it is\b|[^\n]{0,60}\bon purpose\b)/i],
  ["false_positive", "not-a-gap", /^verified[^\n]{0,30}\bnot a gap\b/i],
  ["unknown", "partial", /^part(ial)?ly\b/i],
  ["valid", "fixed", /^(both |all )?fixed\b/i],
  ["valid", "confirmed", /^confirmed\b/i],
  ["valid", "valid", /^valid\b/i],
  ["valid", "agreed", /^agreed\b/i],
  ["valid", "addressed", /^(addressed|adjusted|folded|documented|correct)\b/i],
  ["valid", "deferred", /^deferr(ed|ing)\b/i],
  ["valid", "deferred", /^(noted|acknowledged),? deferr(ed|ing)\b/i],
  ["valid", "applied", /^(applied|resolved|accepted|reproduced|handled)\b/i],
  ["valid", "point-valid", /^the point is valid\b/i],
];

/**
 * Map the first reply in a finding's thread to the verdict /review-pr gave it.
 */
export function classifyReply(body) {
  if (typeof body !== "string" || body.trim() === "") return { verdict: "unknown", rule: "no-reply" };
  const text = body.trim().replace(/^\*\*/, "");
  for (const [verdict, rule, re] of VERDICT_RULES) {
    if (re.test(text)) return { verdict, rule };
  }
  return { verdict: "unknown", rule: "unmatched" };
}

/** Keep the last `maxLines` lines of a diff hunk: the commented line is last. */
export function tailHunk(hunk, maxLines) {
  if (typeof hunk !== "string") return "";
  const lines = hunk.split("\n");
  return lines.length <= maxLines ? hunk : lines.slice(-maxLines).join("\n");
}

/**
 * Pair each finding with the first reply in its thread.
 *
 * @param {Array<{id:number, pr:number, path:string, in_reply_to_id:number|null, body:string, diff_hunk:string, created_at:string}>} rows
 */
export function pairFindings(rows, { hunkLines = 60, repo = "unknown" } = {}) {
  const firstReply = new Map();
  const replies = rows.filter((r) => r.in_reply_to_id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  for (const r of replies) if (!firstReply.has(r.in_reply_to_id)) firstReply.set(r.in_reply_to_id, r);

  const out = [];
  for (const r of rows) {
    if (r.in_reply_to_id) continue;
    const f = parseFinding(r.body);
    if (!f) continue;
    const { verdict, rule } = classifyReply(firstReply.get(r.id)?.body);
    out.push({
      repo,
      pr: r.pr,
      comment_id: r.id,
      finding_id: f.finding_id,
      agent: f.agent,
      category: f.category,
      severity: f.severity,
      mechanical: MECHANICAL.has(f.category),
      title: f.title,
      path: r.path,
      hunk: tailHunk(r.diff_hunk, hunkLines),
      body: f.body,
      verdict,
      verdict_rule: rule,
      posted_at: r.created_at,
    });
  }
  return out.sort((a, b) => a.pr - b.pr || a.comment_id - b.comment_id);
}

/** Counts that are safe to publish: no review text. */
export function datasetCounts(findings) {
  const tally = (key) => findings.reduce((m, f) => ({ ...m, [f[key]]: (m[f[key]] ?? 0) + 1 }), {});
  const primary = findings.filter((f) => !f.mechanical && f.verdict !== "unknown");
  return {
    findings: findings.length,
    pull_requests: new Set(findings.map((f) => `${f.repo}#${f.pr}`)).size,
    verdict: tally("verdict"),
    verdict_rule: tally("verdict_rule"),
    severity: tally("severity"),
    category: tally("category"),
    primary: {
      findings: primary.length,
      valid: primary.filter((f) => f.verdict === "valid").length,
      false_positive: primary.filter((f) => f.verdict === "false_positive").length,
      critical: primary.filter((f) => f.severity === "critical").length,
    },
  };
}

/**
 * One Jev request per finding. The state carries the title, body and hunk,
 * never the posted severity, category or agent: those are what two of the
 * questions ask Jev to predict.
 */
export function buildRequest(finding) {
  const state = [
    `File: ${finding.path}`,
    `Finding: ${finding.title}`,
    "",
    finding.body,
    "",
    "Diff hunk (the commented line is last):",
    finding.hunk,
  ].join("\n");
  return {
    model: JEV_MODEL,
    state,
    questions: {
      real_defect: {
        type: "noul",
        instructions:
          "Is this code review finding correct about the diff, so that the author should change the code or its documentation?",
        criteria: {
          true: "The finding describes a real defect, gap, or risk in the diff.",
          false: "The finding is a false positive: it misreads the code or the intent, or the concern is already handled.",
        },
      },
      category: {
        type: "choice",
        instructions: "Which category best describes this review finding?",
        criteria: {
          bug: "Incorrect behavior or a logic error.",
          style: "Formatting, naming, or code style.",
          test: "Missing, weak, or wrong tests.",
          comment: "A code comment or document that is wrong or missing.",
          type: "A type annotation or type-level contract.",
          simplify: "Code that can be simpler with the same behavior.",
          "error-handling": "A failure that is swallowed, misreported, or unhandled.",
          security: "A vulnerability, secret, or trust-boundary problem.",
          design: "Structure, coupling, or an interface choice.",
        },
      },
      severity: {
        type: "score",
        instructions: "How serious is this finding if it is merged without a change?",
        criteria: [
          "suggestion: a nit; merging without it is fine.",
          "important: it should be fixed, but it does not block the merge.",
          "critical: it must be fixed before the merge.",
        ],
      },
    },
  };
}

/** Rough input-token estimate: four characters per token. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * Send requests one at a time. `fetchImpl` is injected so tests run offline.
 *
 * @returns {Promise<object[]>} one record per finding, with `error` on failure
 */
export async function sendAll(findings, { fetchImpl, apiKey, timeoutMs = 30000, onResult = () => {} }) {
  const results = [];
  for (const f of findings) {
    const started = Date.now();
    const base = {
      comment_id: f.comment_id,
      finding_id: f.finding_id,
      verdict: f.verdict,
      severity: f.severity,
      category: f.category,
      mechanical: f.mechanical,
    };
    let record;
    try {
      const res = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest(f)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latency_ms = Date.now() - started;
      if (!res.ok) {
        record = { ...base, latency_ms, error: `HTTP ${res.status}` };
      } else {
        const data = await res.json();
        record = { ...base, latency_ms, model: data.model, answers: data.answers, usage: data.usage };
      }
    } catch (err) {
      record = { ...base, latency_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
    results.push(record);
    onResult(record);
  }
  return results;
}

/** Cohen's kappa for two binary raters given as arrays of booleans. */
export function cohensKappa(a, b) {
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  let agree = 0;
  let aYes = 0;
  let bYes = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) agree += 1;
    if (a[i]) aYes += 1;
    if (b[i]) bYes += 1;
  }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** Ten equal-width bins of predicted p against the observed valid rate. */
export function reliability(pairs, bins = 10) {
  const rows = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, valid: 0 }));
  for (const { p, valid } of pairs) {
    const i = Math.min(bins - 1, Math.floor(p * bins));
    rows[i].n += 1;
    rows[i].sumP += p;
    if (valid) rows[i].valid += 1;
  }
  const n = pairs.length;
  let ece = 0;
  const table = rows.map((r) => {
    const meanP = r.n ? r.sumP / r.n : null;
    const observed = r.n ? r.valid / r.n : null;
    if (r.n) ece += (r.n / n) * Math.abs(meanP - observed);
    return { lo: r.lo, hi: r.hi, n: r.n, meanP, observed };
  });
  const brier = n ? pairs.reduce((s, { p, valid }) => s + (p - (valid ? 1 : 0)) ** 2, 0) / n : null;
  return { table, ece: n ? ece : null, brier };
}

/**
 * Three-band triage: p ≥ hi is auto-valid, p ≤ lo is auto-false-positive,
 * anything else keeps the full validation. A critical finding is never
 * auto-decided (skills/review-pr/SKILL.md step 3), and neither is one whose
 * severity the posted comment did not state: it could be critical.
 */
export function simulateTriage(rows, { hi, lo }) {
  let autoValid = 0;
  let autoFalsePositive = 0;
  let wrong = 0;
  let droppedDefects = 0;
  let criticalHeld = 0;
  for (const { p, valid, severity } of rows) {
    if (severity === "critical" || severity === "unknown") {
      if (p >= hi || p <= lo) criticalHeld += 1;
      continue;
    }
    if (p >= hi) {
      autoValid += 1;
      if (!valid) wrong += 1;
    } else if (p <= lo) {
      autoFalsePositive += 1;
      if (valid) {
        wrong += 1;
        droppedDefects += 1;
      }
    }
  }
  const n = rows.length;
  const auto = autoValid + autoFalsePositive;
  return {
    n,
    autoValid,
    autoFalsePositive,
    fullValidation: n - auto,
    savedRate: n ? auto / n : 0,
    wrong,
    wrongRate: n ? wrong / n : 0,
    droppedDefects,
    droppedDefectRate: n ? droppedDefects / n : 0,
    criticalHeld,
  };
}

// The rule in docs/experiments/2026-10-12-jev-finding-triage.md, fixed before
// any Jev output exists. Change it there first, never here alone.
export const DECISION_RULE = Object.freeze({
  minPrimary: 100,
  minFalsePositive: 30,
  minKappa: 0.6,
  hi: 0.9,
  lo: 0.1,
  maxWrongRate: 0.02,
  maxDroppedDefectRate: 0.005,
  minSavedRate: 0.2,
});

/** Apply the locked rule. Returns ADOPT, REJECT, or INCONCLUSIVE with reasons. */
export function decide({ primary, falsePositive, kappa, triage }, rule = DECISION_RULE) {
  const reasons = [];
  if (primary < rule.minPrimary || falsePositive < rule.minFalsePositive) {
    reasons.push(
      `sample below the floor: ${primary} primary findings (need ${rule.minPrimary}), ` +
        `${falsePositive} false positives (need ${rule.minFalsePositive})`,
    );
    return { decision: "INCONCLUSIVE", reasons };
  }
  if (kappa === null || kappa < rule.minKappa) reasons.push(`kappa ${kappa?.toFixed(3) ?? "n/a"} < ${rule.minKappa}`);
  if (triage.wrongRate > rule.maxWrongRate) {
    reasons.push(`wrong auto-decisions ${(triage.wrongRate * 100).toFixed(1)}% > ${rule.maxWrongRate * 100}%`);
  }
  if (triage.droppedDefectRate > rule.maxDroppedDefectRate) {
    reasons.push(
      `real defects auto-dismissed ${(triage.droppedDefectRate * 100).toFixed(2)}% > ${rule.maxDroppedDefectRate * 100}%`,
    );
  }
  if (triage.savedRate < rule.minSavedRate) {
    reasons.push(`auto-decided ${(triage.savedRate * 100).toFixed(1)}% < ${rule.minSavedRate * 100}%`);
  }
  return { decision: reasons.length ? "REJECT" : "ADOPT", reasons };
}
