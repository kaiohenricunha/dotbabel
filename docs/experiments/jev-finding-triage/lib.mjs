// Pure helpers shared by extract.mjs, replay.mjs and analyze.mjs. Nothing here
// does I/O except sendAll, which takes its fetch and its sleep as arguments so
// the tests can drive it without a network.

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
export const VERDICTS = Object.freeze(["valid", "false_positive", "unknown"]);

// skills/review-pr/SKILL.md step 3: under --conductor a comment takes the fast
// path, and is never validated, only when it carries the marker, its author is
// the authenticated login, and its category is one of these. A critical
// finding never takes the fast path. pairFindings keeps only comments from the
// posting identity, so the author condition holds for every finding, and a
// finding is mechanical when its category is here and it is not critical. A
// finding whose category the comment does not state cannot take the fast path.
export const MECHANICAL = Object.freeze(new Set(["style", "comment", "type"]));

const MARKER = /<!--\s*post-pr-review:v1:([0-9a-f]{16})\s*-->/;
const AGENT_NAME = "[a-z]+(?:-[a-z]+)*-(?:reviewer|auditor|writer|engineer|specialist|developer)";
const AGENT_WORD = new RegExp(`\\b(${AGENT_NAME})\\b`);
const AGENT_ONLY = new RegExp(`^${AGENT_NAME}$`);
const CATEGORY_LABEL = new RegExp(`\\bcategory:?\\s*\`?(${CATEGORIES.join("|")})\`?`, "i");
// A metadata line: `<sub>agent · category: x · confidence: 84</sub>` or
// `Category: \`test\` · Agent: \`x\` · Confidence: 93`.
const META_LINE = /^\s*(<sub>|_?via\b|\(?confidence\b|(category|agent|severity)\s*:)/i;
const CATEGORY_PAREN = new RegExp(`\\((${CATEGORIES.join("|")})\\)`, "i");
const HEADING = /^#{1,6}\s+(.+)$/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

// The structured positions a severity can take in a posted header. A title
// word is never one: `**Important flag is dropped**` states no severity.
const SEV = "(critical|important|suggestion)";
// `**[important] title**`, `**[🟠 important] title**`, `**[agent · important · design]**`,
// `**[agent / important]**`, `**[important/security] title**`
const SEVERITY_BRACKET = /^(\s*(?:\*\*)?\s*\[)([^\]]*)(\])/;
// `**suggestion** · …`, `**important — title**`, `**suggestion: title**`,
// `**suggestion · design · agent**`, `**[agent] important — title**`: the first
// word of the header, or the first word after a leading bracket, followed by
// the end of the bold run or a separator.
const SEVERITY_LEADING = new RegExp(
  `^(\\s*(?:\\*\\*)?\\s*(?:\\[[^\\]]*\\]\\s*)?[\\s\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]*)${SEV}(?=\\s*(?:\\*\\*|[·|—–:/(]|$))`,
  "iu",
);
// `**title** _(suggestion · agent)_`: a parenthetical whose first item is a severity.
const SEVERITY_PAREN = new RegExp(`(\\(\\s*)${SEV}(?=\\s*[·,)])`, "i");
// `<sub>— agent, severity: important</sub>` on a metadata line.
const SEVERITY_LABEL = new RegExp(`\\bseverity\\s*:\\s*${SEV}\\b`, "i");

const bare = (s) => s.replace(EMOJI, "").replace(/[*_`]/g, "").trim().toLowerCase();
const isMetaPart = (s) => {
  const t = bare(s);
  return t === "" || CATEGORIES.includes(t) || SEVERITIES.includes(t) || AGENT_ONLY.test(t);
};
const META_SEPARATOR = /[·,|/—–]/;

// An underscore is emphasis only at a word edge; inside `high_confidence` it is
// part of the identifier and stays.
const stripMarkup = (s) =>
  s
    .replace(/[*`[\]]/g, "")
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "")
    .replace(EMOJI, "")
    .trim();

/**
 * Read the severity from a structured position only. When it comes from the
 * header, the returned header has that one token removed, so a title that
 * repeats the word keeps it.
 */
function readSeverity(header, metaLines) {
  const bracket = header.match(SEVERITY_BRACKET);
  if (bracket) {
    const parts = bracket[2].split(new RegExp(`(${META_SEPARATOR.source})`));
    const i = parts.findIndex((p, j) => j % 2 === 0 && SEVERITIES.includes(bare(p)));
    if (i !== -1) {
      const severity = bare(parts[i]);
      parts[i] = "";
      return { severity, header: header.replace(SEVERITY_BRACKET, (_, a, __, c) => `${a}${parts.join("")}${c}`) };
    }
  }
  for (const re of [SEVERITY_LEADING, SEVERITY_PAREN]) {
    const m = header.match(re);
    if (m) return { severity: m[2].toLowerCase(), header: header.replace(re, "$1") };
  }
  for (const line of metaLines) {
    const m = line.replace(/[*_`]/g, "").match(SEVERITY_LABEL);
    if (m) return { severity: m[1].toLowerCase(), header };
  }
  return { severity: "unknown", header };
}

const LEADING_BRACKET = /^(\s*(?:\*\*)?\s*)\[([^\]]*)\]/;
const LEADING_BOLD = /^(\s*)\*\*([^*]*)\*\*/;

/**
 * The leading `[...]` bracket, or a leading bold run that holds only metadata
 * (`**important / bug** — title`), is a structured position. Returns the
 * category it names, if any, and the header without the run when the run
 * holds nothing but metadata.
 */
function leadingMeta(header) {
  for (const re of [LEADING_BRACKET, LEADING_BOLD]) {
    const m = header.match(re);
    if (!m) continue;
    const parts = m[2].split(META_SEPARATOR);
    const onlyMeta = parts.every(isMetaPart);
    if (re === LEADING_BOLD && !onlyMeta) return { category: undefined, header };
    const category = parts.map(bare).find((t) => CATEGORIES.includes(t));
    return { category, header: onlyMeta ? header.replace(re, "$1") : header };
  }
  return { category: undefined, header };
}

/**
 * Parse one posted /post-pr-review finding.
 *
 * The agent contract (skills/post-pr-review/references/agent-contract.md)
 * fixes the JSON fields an agent returns, and `severity` and `category` are
 * required there. It does not fix how a posted comment renders them, and this
 * dataset holds many renderings: `**[important] title** · _agent_ · category`,
 * `**suggestion** · \`design\` · _agent_`, a `<sub>` metadata line, and
 * others. So the severity is read only from a structured position (see
 * readSeverity), the agent and category by keyword from the header and the
 * metadata lines, and a field that is absent comes back `unknown`.
 *
 * The posted metadata is removed from the returned title, and the metadata
 * lines are dropped from the body. Body prose is returned as written, so it can
 * still name a severity, a category, or an agent.
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

  const { severity, header: unsevered } = readSeverity(header, metaLines);
  const lead = leadingMeta(unsevered);
  const titleSource = lead.header;
  const agent = region.match(AGENT_WORD)?.[1] ?? "unknown";
  let category = (region.match(CATEGORY_LABEL)?.[1] ?? region.match(CATEGORY_PAREN)?.[1] ?? lead.category)?.toLowerCase();
  if (!category) {
    // `**suggestion** · \`design\` · _agent_` and `… · _agent_ · design`: a
    // separator-delimited segment that is exactly a category name.
    const segments = header.split(/\s[·—|]\s/).map((s) => stripMarkup(s).toLowerCase());
    category = segments.find((s) => CATEGORIES.includes(s)) ?? "unknown";
  }

  const edges = /^[\s·—|:.+-]+|[\s·—|:.+-]+$/g;
  const scrub = (s) => {
    let t = stripMarkup(s)
      .replace(new RegExp(AGENT_WORD.source, "g"), "")
      .replace(/\(?\bconfidence:?\s*\d+\)?\.?/gi, "")
      // A parenthetical that held only metadata, such as `(agent, security)`.
      // `push()` is code and stays: the parenthetical must follow a space.
      .replace(/(^|\s)\(([^()]*)\)/g, (m, lead, inner) => (inner.split(/[·,|]/).every(isMetaPart) ? lead : m))
      .replace(edges, "");
    if (category !== "unknown") {
      for (const seg of t.split(/\s[·—|]\s/)) {
        if (seg.trim().toLowerCase() === category) t = t.replace(seg, "");
      }
    }
    return t
      .replace(/\s\+\s/g, " ")
      .replace(edges, "")
      .replace(/\s+[·|]\s+(?=[·|]|$)/g, "")
      .trim();
  };

  let rest = lines.slice(1).filter((l) => !META_LINE.test(l));
  let title = scrub(titleSource);
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
//
// A rule marked `guarded` opens with agreement but does not say what changed,
// and the same words also open a rejection: "Correct as written", "Valid
// point, but declining". When its first sentence declines the change and does
// not defer it, the verdict is `unknown` with rule `ambiguous`, for hand
// labeling.
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
  ["valid", "confirmed", /^confirmed\b/i, "guarded"],
  ["valid", "valid", /^valid\b/i, "guarded"],
  ["valid", "agreed", /^agreed\b/i, "guarded"],
  ["valid", "addressed", /^(addressed|adjusted|folded)\b/i],
  ["valid", "documented", /^documented\b/i, "guarded"],
  ["valid", "correct", /^correct\b/i, "guarded"],
  ["valid", "deferred", /^deferr(ed|ing)\b/i],
  ["valid", "deferred", /^(noted|acknowledged),? deferr(ed|ing)\b/i],
  ["valid", "applied", /^(applied|resolved|accepted|reproduced|handled)\b/i],
  ["valid", "point-valid", /^the point is valid\b/i],
];
const DECLINE = new RegExp(
  `\\b(${[
    "declin\\w*",
    "not (changed|changing|fixed|fixing)",
    "no (code )?change",
    "unchanged",
    "deliberate(ly)?",
    "intentional(ly)?",
    "by design",
    "on purpose",
    "as (written|is|intended|designed)",
    "keep(ing)?",
    "kept",
    "won't",
    "will not",
    "not (a|an) (bug|defect|gap|problem|issue)",
    "already (handled|covered|exists?|present)",
    "(documented|expected) behaviou?r",
  ].join("|")})\\b`,
  "i",
);
const DEFER = /\bdeferr(ed|ing)\b/i;

/**
 * Map the first reply in a finding's thread to the verdict /review-pr gave it.
 */
export function classifyReply(body) {
  if (typeof body !== "string" || body.trim() === "") return { verdict: "unknown", rule: "no-reply" };
  const text = body.trim().replace(/^\*\*/, "");
  for (const [verdict, rule, re, guarded] of VERDICT_RULES) {
    if (!re.test(text)) continue;
    if (guarded) {
      const first = text.replace(/[*_`]/g, "").split(/(?<=[.!?])\s|\n/)[0];
      if (DECLINE.test(first) && !DEFER.test(first)) return { verdict: "unknown", rule: "ambiguous" };
    }
    return { verdict, rule };
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
 * Validate a hand-label object: `{ "<comment_id>": "valid" | "false_positive" | "unknown" }`.
 *
 * @returns {Map<string, string>}
 */
export function parseLabels(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("the labels file must hold a JSON object keyed by comment id");
  }
  const labels = new Map();
  for (const [id, verdict] of Object.entries(obj)) {
    if (!/^[1-9]\d*$/.test(id)) throw new Error(`label key "${id}" is not a comment id`);
    if (!VERDICTS.includes(verdict)) throw new Error(`label for ${id} must be a verdict (${VERDICTS.join(", ")})`);
    labels.set(id, verdict);
  }
  return labels;
}

/**
 * Pair each finding with the first reply in its thread.
 *
 * Only comments from an allowlisted author count, as findings and as verdict
 * replies: the marker is public text that anyone can paste on a public
 * repository. The allowlist defaults to the owner of `repo`. A hand label for
 * a comment id replaces the verdict that the text rules gave.
 *
 * @param {Array<{id:number, pr:number, path:string, user:string, in_reply_to_id:number|null, body:string, diff_hunk:string, created_at:string, commit_id?:string, original_commit_id?:string, line?:number|null}>} rows
 * @param {{hunkLines?:number, repo?:string, authors?:string[], labels?:Map<string,string>}} [options]
 */
export function pairFindings(rows, { hunkLines = 60, repo = "unknown", authors, labels = new Map() } = {}) {
  const allowList = authors ?? (repo.includes("/") ? [repo.split("/")[0]] : []);
  const allowed = new Set(allowList.map((a) => a.toLowerCase()));
  if (allowed.size === 0) throw new Error("pairFindings needs an author allowlist or an owner/name repo");
  const byAllowed = (r) => typeof r.user === "string" && allowed.has(r.user.toLowerCase());

  const firstReply = new Map();
  const replies = rows
    .filter((r) => r.in_reply_to_id && byAllowed(r))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  for (const r of replies) if (!firstReply.has(r.in_reply_to_id)) firstReply.set(r.in_reply_to_id, r);

  const out = [];
  for (const r of rows) {
    if (r.in_reply_to_id || !byAllowed(r)) continue;
    const f = parseFinding(r.body);
    if (!f) continue;
    const reply = firstReply.get(r.id);
    const label = labels.get(String(r.id));
    const { verdict, rule } = label === undefined ? classifyReply(reply?.body) : { verdict: label, rule: "hand-label" };
    out.push({
      repo,
      pr: r.pr,
      comment_id: r.id,
      finding_id: f.finding_id,
      user: r.user,
      commit_id: r.commit_id ?? null,
      original_commit_id: r.original_commit_id ?? null,
      line: r.line ?? null,
      agent: f.agent,
      category: f.category,
      severity: f.severity,
      mechanical: MECHANICAL.has(f.category) && f.severity !== "critical",
      title: f.title,
      path: r.path,
      hunk: tailHunk(r.diff_hunk, hunkLines),
      body: f.body,
      verdict,
      verdict_rule: rule,
      verdict_user: reply?.user ?? null,
      posted_at: r.created_at,
    });
  }
  return out.sort((a, b) => a.pr - b.pr || a.comment_id - b.comment_id);
}

/**
 * Who wrote the marker comments and the replies to them, before any author
 * filter. An author outside the allowlist shows up here and not in the data.
 */
export function authorTally(rows) {
  const markers = new Set(rows.filter((r) => !r.in_reply_to_id && parseFinding(r.body)).map((r) => r.id));
  const findings = {};
  const replies = {};
  for (const r of rows) {
    const login = r.user ?? "unknown";
    if (!r.in_reply_to_id && markers.has(r.id)) findings[login] = (findings[login] ?? 0) + 1;
    else if (r.in_reply_to_id && markers.has(r.in_reply_to_id)) replies[login] = (replies[login] ?? 0) + 1;
  }
  return { findings, replies };
}

/** The primary set: outside the mechanical categories, with a valid or false-positive verdict. */
export const isPrimary = (f) => !f.mechanical && (f.verdict === "valid" || f.verdict === "false_positive");

/** Counts that are safe to publish: no review text. */
export function datasetCounts(findings) {
  const tallyOf = (list, key) =>
    list.reduce((m, f) => {
      const k = f[key] ?? "none";
      return { ...m, [k]: (m[k] ?? 0) + 1 };
    }, {});
  const tally = (key) => tallyOf(findings, key);
  const primary = findings.filter(isPrimary);
  const stated = primary.filter((f) => f.severity !== "unknown");
  const eligible = stated.filter((f) => f.severity !== "critical");
  const dates = findings.map((f) => f.posted_at).filter(Boolean).sort();
  return {
    findings: findings.length,
    pull_requests: new Set(findings.map((f) => `${f.repo}#${f.pr}`)).size,
    posted_at: { first: dates[0] ?? null, last: dates.at(-1) ?? null },
    author: tally("user"),
    verdict_author: tally("verdict_user"),
    verdict: tally("verdict"),
    verdict_rule: tally("verdict_rule"),
    hand_labels: tallyOf(
      findings.filter((f) => f.verdict_rule === "hand-label"),
      "verdict",
    ),
    severity: tally("severity"),
    category: tally("category"),
    primary: {
      findings: primary.length,
      valid: primary.filter((f) => f.verdict === "valid").length,
      false_positive: primary.filter((f) => f.verdict === "false_positive").length,
      critical: primary.filter((f) => f.severity === "critical").length,
      severity_stated: stated.length,
      eligible: eligible.length,
      eligible_false_positive: eligible.filter((f) => f.verdict === "false_positive").length,
    },
  };
}

/**
 * One Jev request per finding. The state carries the file path, the title,
 * the body and the hunk. The posted severity, category and agent fields are
 * not sent, because two of the questions ask Jev to predict them. Body prose is
 * sent as written and can still contain those words.
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

/** Parse a flag value that must be a positive integer, such as --limit. */
export function parsePositiveInt(flag, value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} needs a positive integer, got "${value}"`);
  }
  return Number(value);
}

/**
 * A Jev answer is usable when it has no error and a `real_defect.noul` that is
 * a number in [0, 1]. Anything else counts as a failed request.
 */
export function isUsableAnswer(record) {
  const noul = record?.answers?.real_defect?.noul;
  return Boolean(record) && !record.error && typeof noul === "number" && noul >= 0 && noul <= 1;
}

/**
 * One record per comment from an answers file that a resumed run appended to:
 * the last usable record, or the last record when none is usable.
 *
 * @returns {Map<number, object>}
 */
export function latestAnswers(records) {
  const out = new Map();
  for (const r of records) {
    const prev = out.get(r.comment_id);
    if (isUsableAnswer(r) || !isUsableAnswer(prev)) out.set(r.comment_id, r);
  }
  return out;
}

/**
 * How long to wait before the next attempt, or null to stop. A `Retry-After`
 * header (seconds or an HTTP date) wins; a value above `maxDelayMs` stops the
 * retries rather than shortening the wait. Without the header the wait doubles
 * from `baseDelayMs` and is capped at `maxDelayMs`.
 */
export function retryDelayMs(retryAfter, attempt, { baseDelayMs, maxDelayMs, now = Date.now() }) {
  if (typeof retryAfter === "string" && retryAfter.trim() !== "") {
    const v = retryAfter.trim();
    const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
    if (Number.isFinite(ms)) return ms > maxDelayMs ? null : Math.max(0, ms);
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send requests one at a time. A 429, a 5xx, a timeout, or a network error is
 * retried up to `maxAttempts` times; any other HTTP error is not. `fetchImpl`
 * and `sleep` are injected so tests run offline.
 *
 * @returns {Promise<object[]>} one record per finding, with `error` on failure
 */
export async function sendAll(
  findings,
  {
    fetchImpl,
    apiKey,
    timeoutMs = 30000,
    maxAttempts = 4,
    baseDelayMs = 1000,
    maxDelayMs = 300000,
    sleep = sleepFor,
    onResult = () => {},
  },
) {
  // An error message can echo a header value; never let it carry the key.
  const redact = (msg) => (apiKey ? msg.split(apiKey).join("<redacted>") : msg);
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
    for (let attempt = 1; ; attempt += 1) {
      let retryAfter = null;
      let retryable = false;
      try {
        const res = await fetchImpl(JEV_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildRequest(f)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const data = await res.json();
          record = { ...base, model: data.model, answers: data.answers, usage: data.usage };
        } else {
          record = { ...base, error: `HTTP ${res.status}` };
          retryable = res.status === 429 || res.status >= 500;
          retryAfter = res.headers?.get?.("retry-after") ?? null;
        }
      } catch (err) {
        record = { ...base, error: redact(err instanceof Error ? err.message : String(err)) };
        retryable = true;
      }
      record.attempts = attempt;
      if (!retryable || attempt >= maxAttempts) break;
      const wait = retryDelayMs(retryAfter, attempt, { baseDelayMs, maxDelayMs });
      if (wait === null) {
        record.error += ` (Retry-After ${retryAfter} s is over the ${maxDelayMs / 1000} s cap)`;
        break;
      }
      await sleep(wait);
    }
    record.latency_ms = Date.now() - started;
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

// A small seeded PRNG, so a bootstrap interval is the same on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A percentile bootstrap interval that resamples whole clusters (pull
 * requests), because findings on one pull request are not independent.
 * Resamples where `stat` returns null are dropped.
 *
 * @returns {{lo:number, hi:number, resamples:number} | null}
 */
export function clusterBootstrap(rows, clusterOf, stat, { resamples = 2000, seed = 1, level = 0.95 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = clusterOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const clusters = [...groups.values()];
  if (clusters.length === 0) return null;
  const rand = mulberry32(seed);
  const values = [];
  for (let b = 0; b < resamples; b += 1) {
    const sample = [];
    for (let i = 0; i < clusters.length; i += 1) {
      for (const r of clusters[Math.floor(rand() * clusters.length)]) sample.push(r);
    }
    const v = stat(sample);
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  values.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const pick = (q) => values[Math.round(q * (values.length - 1))];
  return { lo: pick(tail), hi: pick(1 - tail), resamples: values.length };
}

/**
 * Three-band triage: p ≥ hi is auto-valid, p ≤ lo is auto-false-positive,
 * anything else keeps the full validation. Both bounds are inclusive.
 *
 * The triage set is the rows that state a severity; a row that does not could
 * be critical, so it is left out (`unstated`). A critical row is in the set but
 * never auto-decided (skills/review-pr/SKILL.md step 3). The other rows are
 * the eligible ones, and each gate is a rate over the rows it applies to:
 *
 * - falsePositiveLeak: auto-valid false positives / eligible false positives
 * - autoFalsePositivePrecision: false positives / rows at p ≤ lo
 * - droppedDefectRate: valid rows at p ≤ lo / eligible valid rows
 * - savedRate: auto-decided rows / the triage set
 *
 * A rate with an empty denominator is null.
 */
export function simulateTriage(rows, { hi, lo }) {
  const ratio = (a, b) => (b ? a / b : null);
  let unstated = 0;
  let n = 0;
  let eligibleValid = 0;
  let eligibleFalsePositive = 0;
  let autoValid = 0;
  let autoFalsePositive = 0;
  let leakedFalsePositive = 0;
  let autoFalsePositiveCorrect = 0;
  let droppedDefects = 0;
  let criticalHeld = 0;
  for (const { p, valid, severity } of rows) {
    if (severity === "unknown") {
      unstated += 1;
      continue;
    }
    n += 1;
    if (severity === "critical") {
      if (p >= hi || p <= lo) criticalHeld += 1;
      continue;
    }
    if (valid) eligibleValid += 1;
    else eligibleFalsePositive += 1;
    if (p >= hi) {
      autoValid += 1;
      if (!valid) leakedFalsePositive += 1;
    } else if (p <= lo) {
      autoFalsePositive += 1;
      if (valid) droppedDefects += 1;
      else autoFalsePositiveCorrect += 1;
    }
  }
  const autoDecided = autoValid + autoFalsePositive;
  return {
    n,
    unstated,
    eligible: eligibleValid + eligibleFalsePositive,
    eligibleValid,
    eligibleFalsePositive,
    autoValid,
    autoFalsePositive,
    autoDecided,
    fullValidation: n - autoDecided,
    criticalHeld,
    leakedFalsePositive,
    falsePositiveLeak: ratio(leakedFalsePositive, eligibleFalsePositive),
    autoFalsePositiveCorrect,
    autoFalsePositivePrecision: ratio(autoFalsePositiveCorrect, autoFalsePositive),
    droppedDefects,
    droppedDefectRate: ratio(droppedDefects, eligibleValid),
    savedRate: n ? autoDecided / n : 0,
  };
}

// The rule in docs/experiments/2026-10-12-jev-finding-triage.md, fixed before
// any Jev output exists. Change it there first, never here alone. The gates
// compare point estimates; analyze.mjs prints a bootstrap interval beside each.
export const DECISION_RULE = Object.freeze({
  minPrimary: 100,
  minFalsePositive: 30,
  minEligibleFalsePositive: 20,
  minKappa: 0.6,
  hi: 0.9,
  lo: 0.1,
  maxFalsePositiveLeak: 0.25,
  minAutoFalsePositivePrecision: 0.8,
  maxDroppedDefectRate: 0.005,
  minSavedRate: 0.2,
});

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const limit = (x) => `${+(x * 100).toFixed(2)}%`;

/**
 * Apply the locked rule to point estimates. The sample floor counts only
 * findings with a usable Jev answer. Returns INCONCLUSIVE when the sample is
 * below the floor, REJECT when any gate fails, ADOPT otherwise, with reasons.
 */
export function decide({ primary, falsePositive, kappa, triage }, rule = DECISION_RULE) {
  if (
    primary < rule.minPrimary ||
    falsePositive < rule.minFalsePositive ||
    triage.eligibleFalsePositive < rule.minEligibleFalsePositive
  ) {
    return {
      decision: "INCONCLUSIVE",
      reasons: [
        `sample below the floor: ${primary} primary findings with a usable answer (need ${rule.minPrimary}), ` +
          `${falsePositive} of them false positives (need ${rule.minFalsePositive}), ` +
          `${triage.eligibleFalsePositive} eligible for triage (need ${rule.minEligibleFalsePositive})`,
      ],
    };
  }
  const t = triage;
  const reasons = [];
  if (kappa === null || kappa < rule.minKappa) reasons.push(`kappa ${kappa?.toFixed(3) ?? "n/a"} < ${rule.minKappa}`);
  if (t.falsePositiveLeak > rule.maxFalsePositiveLeak) {
    reasons.push(
      `false positives auto-validated ${t.leakedFalsePositive} of ${t.eligibleFalsePositive} ` +
        `(${pct(t.falsePositiveLeak)}) > ${limit(rule.maxFalsePositiveLeak)}`,
    );
  }
  if (t.autoFalsePositivePrecision !== null && t.autoFalsePositivePrecision < rule.minAutoFalsePositivePrecision) {
    reasons.push(
      `auto-dismissed findings that are false positives ${t.autoFalsePositiveCorrect} of ${t.autoFalsePositive} ` +
        `(${pct(t.autoFalsePositivePrecision)}) < ${limit(rule.minAutoFalsePositivePrecision)}`,
    );
  }
  if (t.droppedDefectRate !== null && t.droppedDefectRate > rule.maxDroppedDefectRate) {
    reasons.push(
      `real defects auto-dismissed ${t.droppedDefects} of ${t.eligibleValid} ` +
        `(${pct(t.droppedDefectRate, 2)}) > ${limit(rule.maxDroppedDefectRate)}`,
    );
  }
  if (t.savedRate < rule.minSavedRate) {
    reasons.push(`auto-decided ${t.autoDecided} of ${t.n} (${pct(t.savedRate)}) < ${limit(rule.minSavedRate)}`);
  }
  return { decision: reasons.length ? "REJECT" : "ADOPT", reasons };
}
