// Behavioral boundaries of `criteria/comment.mjs` (TEST-1, mutation floor 85).
//
// `criteria-comment.test.mjs` proves the comment carries its marker and payload,
// escapes spec text, and stays under the size limit. What it leaves loose is the
// arithmetic at the edges: whether a comment of EXACTLY the limit is posted or
// shrunk, how many rows survive a truncation, what a tests cell counts as
// confirmed, and the precise `gh` calls that post one comment and hide the
// previous ones. Those decisions fail quietly. An off-by-one at the limit drops a
// row nobody notices, and a wrong `gh` flag hides the wrong comment.
//
// Assertions state outcomes of the rendered comment or the calls made. The exact
// `gh` argv and the readable-section layout are asserted verbatim on purpose:
// GitHub's renderer and `gh` are the consumers, and both are exact about them.

import { describe, expect, it } from "vitest";

import { buildCriteriaMarker, postEvidenceComment, renderEvidenceComment, CRITERIA_MARKER_PREFIX, PAYLOAD_LINE_PREFIX } from "../src/criteria/comment.mjs";

const LIMIT = 60000;
const SHA = "a".repeat(40);

const criterion = (id, extra = {}) => ({ id, status: "pass", ...extra });
const payloadOf = (criteria, { specId = "example", filler = 0 } = {}) => ({
  head_sha: SHA,
  specs: [{ id: specId, criteria }],
  ...(filler > 0 ? { filler: "f".repeat(filler) } : {}),
});

/**
 * Text in which every position is distinguishable: numbered words, so the first
 * N characters and the last N characters can never coincide. Periodic filler
 * ("abc" repeated, "0123456789" repeated) can make the start and the end of a
 * slice identical, which hides exactly the bug a test of "keeps the END" exists
 * to find.
 */
const uniqueText = (length) => {
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += `${String(i).padStart(6, "0")} `;
  return out.slice(0, length);
};

/** Everything after the marker and payload lines. */
const readable = (body) => body.split("\n").slice(2).join("\n");
const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The marker line plus the payload line, computed from the documented format. */
const fixedLength = (payload) =>
  buildCriteriaMarker(payload.head_sha).length + 1 + PAYLOAD_LINE_PREFIX.length + Buffer.from(JSON.stringify(payload)).toString("base64url").length + " -->".length;

/**
 * Find a payload whose marker and payload lines are exactly `target` long.
 *
 * The length is a constant plus ceil(4n/3) for n payload bytes, so it can only
 * take three of every four values: some targets are unreachable however the
 * payload is padded. Both knobs below add bytes, so the second one only widens
 * the search around the estimate rather than reaching new residues. Callers that
 * need "just over" rather than an exact value use {@link payloadJustOver}.
 */
function payloadWithFixedLength(criteria, target) {
  const at = (filler, pad) => payloadOf(criteria, { specId: `example${"s".repeat(pad)}`, filler });
  const low = fixedLength(at(1000, 0));
  const high = fixedLength(at(31000, 0));
  const estimate = Math.round(1000 + ((target - low) * 30000) / (high - low));
  for (let filler = estimate - 12; filler <= estimate + 12; filler += 1) {
    for (let pad = 0; pad < 6; pad += 1) {
      const candidate = at(filler, pad);
      if (fixedLength(candidate) === target) return candidate;
    }
  }
  throw new Error(`could not tune a payload to a fixed length of ${target}`);
}

/** The nearest reachable fixed length above `limit`, within a few characters. */
function payloadJustOver(criteria, limit) {
  for (let over = 1; over <= 4; over += 1) {
    try {
      return payloadWithFixedLength(criteria, limit + over);
    } catch {
      // That residue is unreachable; try the next value up.
    }
  }
  throw new Error(`no payload found with a fixed length just over ${limit}`);
}

/**
 * Find a payload whose render is exactly `target` long, measured with `tails`
 * (whatever shape the stage under test uses). Renders shorter than the limit are
 * returned whole, so the measurement is exact until the target is crossed.
 */
function payloadWithRenderLength(criteria, target, tails, accept = () => true) {
  const at = (filler, pad) => payloadOf(criteria, { specId: `example${"s".repeat(pad)}`, filler });
  const measure = (payload) => renderEvidenceComment(payload, tails(payload)).length;
  const low = measure(at(1000, 0));
  const high = measure(at(31000, 0));
  const estimate = Math.round(1000 + ((target - low) * 30000) / (high - low));
  for (let filler = estimate - 14; filler <= estimate + 14; filler += 1) {
    for (let pad = 0; pad < 6; pad += 1) {
      const candidate = at(filler, pad);
      const body = renderEvidenceComment(candidate, tails(candidate));
      if (body.length === target && accept(body)) return candidate;
    }
  }
  throw new Error(`could not tune a payload to a render length of ${target}`);
}

describe("the tests cell", () => {
  const cell = (tests) => {
    const body = renderEvidenceComment(payloadOf([criterion("AC-1", { tests, duration_ms: 3 })]), {});
    return readable(body).split("\n").find((l) => l.startsWith("| example | AC-1"));
  };

  it("counts a test as confirmed when it passed, failed or errored, out of all of them", () => {
    const tests = [{ result: "passed" }, { result: "failed" }, { result: "error" }, { result: "skipped" }, { result: "unconfirmed" }, {}];
    expect(cell(tests)).toBe("| example | AC-1 | pass | 3/6 | 3ms |");
  });

  it("does not count skipped, unconfirmed or unresulted tests", () => {
    expect(cell([{ result: "skipped" }, { result: "unconfirmed" }, {}])).toBe("| example | AC-1 | pass | 0/3 | 3ms |");
  });

  it("counts each confirmed outcome on its own", () => {
    for (const result of ["passed", "failed", "error"]) expect(cell([{ result }])).toContain("| 1/1 |");
  });

  it("shows zero of zero for an empty list, and a dash when there is no list at all", () => {
    expect(cell([])).toContain("| 0/0 |");
    expect(cell(undefined)).toContain("| — |");
    expect(cell("not a list")).toContain("| — |");
    expect(cell(null)).toContain("| — |");
  });

  it("shows the duration in milliseconds when it is a number, and a dash otherwise", () => {
    const duration = (d) => {
      const body = renderEvidenceComment(payloadOf([criterion("AC-1", { duration_ms: d })]), {});
      return readable(body).split("\n").find((l) => l.startsWith("| example | AC-1")).split("|")[5].trim();
    };
    expect(duration(0)).toBe("0ms");
    expect(duration(1250)).toBe("1250ms");
    expect(duration("12")).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration(null)).toBe("—");
  });
});

describe("escaping in table cells and summaries", () => {
  it("escapes backslash, ampersand, angle brackets and pipe, backslash first so nothing is escaped twice", () => {
    const body = renderEvidenceComment(payloadOf([criterion("a\\b&c<d>e|f")], { specId: "x\\|y" }), {});
    expect(readable(body)).toContain("| x\\\\\\|y | a\\\\b&amp;c&lt;d&gt;e\\|f | pass |");
  });

  it("leaves ordinary text alone", () => {
    expect(readable(renderEvidenceComment(payloadOf([criterion("AC-12")]), {}))).toContain("| example | AC-12 | pass |");
  });
});

describe("the readable section", () => {
  it("lays out heading, table and details blocks exactly as GitHub will render them", () => {
    // The one verbatim layout assertion. Blank lines matter to the renderer: a
    // fenced block inside <details> is not rendered unless a blank line follows
    // the summary, and the closing tag needs one before it.
    const payload = payloadOf([criterion("AC-1", { tests: [{ result: "passed" }, { result: "skipped" }], duration_ms: 10 }), criterion("AC-2", { status: "fail" }), criterion("AC-3")]);
    const body = renderEvidenceComment(payload, { example: { "AC-1": "first tail", "AC-3": "third tail" } });
    expect(readable(body)).toBe(
      [
        "### Acceptance criteria evidence",
        "",
        "| Spec | Criterion | Status | Tests | Duration |",
        "| ---- | --------- | ------ | ----- | -------- |",
        "| example | AC-1 | pass | 1/2 | 10ms |",
        "| example | AC-2 | fail | — | — |",
        "| example | AC-3 | pass | — | — |",
        "",
        "<details><summary>example AC-1 output</summary>",
        "",
        "```",
        "first tail",
        "```",
        "",
        "</details>",
        "<details><summary>example AC-3 output</summary>",
        "",
        "```",
        "third tail",
        "```",
        "",
        "</details>",
      ].join("\n"),
    );
  });
});

describe("which criteria get an output block", () => {
  const blocks = (payload, tails) => count(renderEvidenceComment(payload, tails), "<details>");
  const two = payloadOf([criterion("AC-1"), criterion("AC-2")]);

  it("gives a block only to a criterion that has a tail, and none when tails are absent", () => {
    expect(blocks(two, { example: { "AC-1": "t" } })).toBe(1);
    expect(blocks(two, { example: { "AC-1": "t", "AC-2": "u" } })).toBe(2);
    expect(blocks(two, {})).toBe(0);
    expect(blocks(two, undefined)).toBe(0);
    expect(blocks(two, null)).toBe(0);
  });

  it("does not throw for tails that name a different spec or a missing criterion", () => {
    expect(blocks(two, { other: { "AC-1": "t" } })).toBe(0);
    expect(blocks(two, { example: {} })).toBe(0);
    expect(blocks(two, { example: null })).toBe(0);
  });

  it("gives an empty tail a block with nothing inside it, distinct from having no tail", () => {
    const body = renderEvidenceComment(two, { example: { "AC-1": "" } });
    expect(count(body, "<details>")).toBe(1);
    expect(body).toContain("```\n\n```");
  });

  it("stringifies a tail that is not text", () => {
    expect(renderEvidenceComment(two, { example: { "AC-1": 12345 } })).toContain("```\n12345\n```");
  });
});

describe("fencing output", () => {
  const fenceOf = (tail) => {
    const body = renderEvidenceComment(payloadOf([criterion("AC-1")]), { example: { "AC-1": tail } });
    return body.split("\n").find((l) => /^`+$/.test(l));
  };

  it("uses the shortest fence, three backticks, when the output has none or fewer than three in a row", () => {
    expect(fenceOf("plain output")).toBe("```");
    expect(fenceOf("one ` and two `` here")).toBe("```");
  });

  it("uses a fence one longer than the longest run of backticks in the output", () => {
    expect(fenceOf("has ``` inside")).toBe("````");
    expect(fenceOf("has ````` inside and ` alone")).toBe("``````");
  });
});

describe("the size limit", () => {
  const one = [criterion("AC-1")];
  const marker = buildCriteriaMarker(SHA);

  it("refuses when the marker and payload lines alone are over the limit, but renders at exactly the limit", () => {
    const exact = payloadWithFixedLength(one, LIMIT);
    expect(fixedLength(exact)).toBe(LIMIT);
    expect(() => renderEvidenceComment(exact, {})).not.toThrow();

    const over = payloadJustOver(one, LIMIT);
    expect(fixedLength(over)).toBeGreaterThan(LIMIT);
    expect(fixedLength(over)).toBeLessThanOrEqual(LIMIT + 4);
    expect(() => renderEvidenceComment(over, {})).toThrow(/exceeds/);
  });

  it("falls back to the marker and payload lines alone when not even the table header fits beside them", () => {
    const payload = payloadWithFixedLength(one, LIMIT);
    const body = renderEvidenceComment(payload, {});
    expect(body.length).toBe(LIMIT);
    expect(body.split("\n")).toHaveLength(2);
    expect(body.startsWith(marker)).toBe(true);
  });

  it("returns a comment of exactly the limit whole, and shrinks one that is a character over", () => {
    // One tail is the only variable-length part and each character adds exactly
    // one, so the total is easy to place on the limit.
    const base = renderEvidenceComment(payloadOf(one), { example: { "AC-1": "" } }).length;
    const fitsExactly = "t".repeat(LIMIT - base);
    const whole = renderEvidenceComment(payloadOf(one), { example: { "AC-1": fitsExactly } });
    expect(whole.length).toBe(LIMIT);
    expect(whole).toContain(fitsExactly);

    const shrunk = renderEvidenceComment(payloadOf(one), { example: { "AC-1": `${fitsExactly}t` } });
    expect(shrunk.length).toBe(LIMIT);
    expect(shrunk).toContain(fitsExactly.slice(1));
    expect(shrunk).not.toContain(`${fitsExactly}t`);
  });

  it("keeps the END of a tail when it has to cut, and as much of it as fits", () => {
    const base = renderEvidenceComment(payloadOf(one), { example: { "AC-1": "" } }).length;
    const tail = uniqueText(LIMIT);
    const body = renderEvidenceComment(payloadOf(one), { example: { "AC-1": tail } });
    const room = LIMIT - base;
    expect(body.length).toBe(LIMIT);
    expect(body).toContain(tail.slice(-room));
    expect(body).not.toContain(tail.slice(-(room + 1)));
    // And it is the end that survives, not the start.
    expect(body).not.toContain(tail.slice(0, room));
  });

  it("places the cut so that the result is exactly as long as the limit allows, not one short", () => {
    // A payload whose empty-tail render sits `room` below the limit, so exactly
    // `room` tail characters fit. An off-by-one in the search keeps one fewer.
    const room = 500;
    const payload = payloadWithRenderLength(one, LIMIT - room, (p) => ({ [p.specs[0].id]: { "AC-1": "" } }), (b) => b.includes("<details>"));
    const tail = uniqueText(4000);
    const body = renderEvidenceComment(payload, { [payload.specs[0].id]: { "AC-1": tail } });
    expect(body.length).toBe(LIMIT);
    expect(body).toContain(tail.slice(-room));
    expect(body).not.toContain(tail.slice(-(room + 1)));
    expect(body).not.toContain(tail.slice(0, room));
  });

  it("keeps every output block, emptied, when that is the last thing that fits", () => {
    const payload = payloadWithRenderLength(one, LIMIT, (p) => ({ [p.specs[0].id]: { "AC-1": "" } }), (b) => b.includes("<details>"));
    // `~` is outside the base64url alphabet, so it cannot come from the payload line.
    const body = renderEvidenceComment(payload, { [payload.specs[0].id]: { "AC-1": "~".repeat(5000) } });
    expect(body.length).toBe(LIMIT);
    expect(count(body, "<details>")).toBe(1);
    expect(body).not.toContain("~");
    expect(body).toContain("```\n\n```");
  });

  it("drops output blocks, keeping every row, when only the rows still fit exactly", () => {
    const payload = payloadWithRenderLength(one, LIMIT, () => undefined);
    const body = renderEvidenceComment(payload, { [payload.specs[0].id]: { "AC-1": "t".repeat(3000) } });
    expect(body.length).toBe(LIMIT);
    expect(body).not.toContain("<details>");
    expect(body).not.toMatch(/more criteria not shown/);
    expect(body).toContain("| AC-1 |");
  });

  it("skips criteria without a tail when working out how large a tail could be", () => {
    const criteria = [criterion("AC-1"), criterion("AC-2"), criterion("AC-3")];
    const payload = payloadOf(criteria);
    const body = renderEvidenceComment(payload, { example: { "AC-2": "m".repeat(70000) } });
    expect(body.length).toBeLessThanOrEqual(LIMIT);
    expect(count(body, "<details>")).toBe(1);
    expect(body).toContain("example AC-2 output");
  });

  it("caps the rows and says how many were left out, so shown plus omitted is everything", () => {
    const criteria = Array.from({ length: 1000 }, (_, i) => criterion(`AC-${i + 1}`));
    const payload = payloadOf(criteria);
    const body = renderEvidenceComment(payload, { example: { "AC-1": "tail" } });
    expect(body.length).toBeLessThanOrEqual(LIMIT);
    const lines = readable(body).split("\n");
    const shown = lines.filter((l) => /^\| example \| AC-\d+ \|/.test(l)).length;
    const omitted = Number(/\| … \| (\d+) more criteria not shown \|/.exec(readable(body))?.[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(1000);
    expect(shown + omitted).toBe(1000);
    // The rows kept are the first ones, in order.
    expect(lines.find((l) => l.startsWith("| example | AC-1 |"))).toBeDefined();
    expect(body).not.toContain(`| AC-${shown + 1} |`);
    expect(body).toContain(`| AC-${shown} |`);
  });

  it("keeps as many rows as fit: one more would go over the limit", () => {
    // Rows are equal width here, so the room left after the last one is always
    // smaller than the next row. A search that settles one row early leaves a
    // gap at least a full row wide.
    const criteria = Array.from({ length: 1000 }, (_, i) => criterion(`AC-${String(i + 1).padStart(4, "0")}`));
    for (const filler of [0, 7, 19, 33, 48, 61]) {
      const body = renderEvidenceComment(payloadOf(criteria, { filler }), undefined);
      const rowWidth = readable(body).split("\n").find((l) => l.startsWith("| example | AC-0001 |")).length + 1;
      expect(LIMIT - body.length, `filler ${filler}`).toBeLessThan(rowWidth);
      expect(body.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("does not spend the limit on output blocks once it has given them up for rows", () => {
    // Same room check as above, but with a tail present. Once output has been
    // dropped, a tail's block must not be counted against the rows: doing so
    // would leave a gap far wider than a row.
    const criteria = Array.from({ length: 1000 }, (_, i) => criterion(`AC-${String(i + 1).padStart(4, "0")}`));
    for (const filler of [0, 7, 19, 33, 48, 61]) {
      const body = renderEvidenceComment(payloadOf(criteria, { filler }), { example: { "AC-0001": "a tail worth keeping" } });
      const rowWidth = readable(body).split("\n").find((l) => l.startsWith("| example | AC-0001 |")).length + 1;
      expect(body).not.toContain("<details>");
      expect(LIMIT - body.length, `filler ${filler}`).toBeLessThan(rowWidth);
      expect(body.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("places the row cut exactly on the limit when a row count lands there", () => {
    const criteria = Array.from({ length: 1000 }, (_, i) => criterion(`AC-${String(i + 1).padStart(4, "0")}`));
    let found = null;
    for (let filler = 0; filler < 1400 && found === null; filler += 1) {
      const body = renderEvidenceComment(payloadOf(criteria, { filler }), undefined);
      if (body.length === LIMIT) found = { filler, body };
    }
    expect(found, "no filler size put a row count exactly on the limit").not.toBeNull();
    // Exactly on the limit means the cut kept the largest row count that fits;
    // one fewer would leave a gap a full row wide.
    expect(found.body.length).toBe(LIMIT);
    expect(found.body).toMatch(/more criteria not shown/);
  });
});

describe("postEvidenceComment", () => {
  const MARKER = `${CRITERIA_MARKER_PREFIX}${SHA} -->`;

  function deps({ me = "octocat\n", comments = [], omitLog = false } = {}) {
    const calls = [];
    const posted = [];
    const logs = [];
    const d = {
      capture: (argv) => {
        calls.push(argv);
        if (argv[2] === "user") return me;
        if (argv[2] === "graphql") return "";
        return JSON.stringify(comments);
      },
      ghApiWithInput: (argv, json) => posted.push({ argv, json }),
    };
    if (!omitLog) d.log = (m) => logs.push(m);
    return { d, calls, posted, logs };
  }
  const post = (d, over = {}) => postEvidenceComment(d, { repo: "o/r", pr: 7, body: "the body", ...over });
  const minimizes = (calls) => calls.filter((c) => c[2] === "graphql");
  const mine = (id, node) => ({ user: { login: "octocat" }, body: `${MARKER}\ntext`, node_id: node ?? id });

  it("asks who it is running as, lists the pull request's comments with pagination, then posts once", () => {
    const { d, calls, posted } = deps();
    post(d);
    expect(calls[0]).toEqual(["gh", "api", "user", "--jq", ".login"]);
    expect(calls[1]).toEqual(["gh", "api", "repos/o/r/issues/7/comments", "--paginate"]);
    expect(posted).toEqual([{ argv: ["gh", "api", "--method", "POST", "repos/o/r/issues/7/comments", "--input", "-"], json: { body: "the body" } }]);
  });

  it("recognises its own comments even though `gh` prints the login with a trailing newline", () => {
    const { d, calls } = deps({ me: "octocat\n", comments: [mine("A", "NODE_A")] });
    post(d);
    expect(minimizes(calls)).toHaveLength(1);
  });

  it("minimizes with a typed id variable, marking the comment outdated rather than deleting it", () => {
    const { d, calls } = deps({ comments: [mine("A", "NODE_A")] });
    post(d);
    const [argv] = minimizes(calls);
    expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    const query = argv[argv.indexOf("-f") + 1];
    expect(query).toMatch(/^query=mutation\(\$id: ID!\)/);
    expect(query).toContain("minimizeComment");
    expect(query).toContain("subjectId: $id");
    expect(query).toContain("classifier: OUTDATED");
    // `-F`, not `-f`: only the typed flag lets the id reach an ID! variable.
    expect(argv[argv.indexOf("-F") + 1]).toBe("id=NODE_A");
  });

  it("only touches comments that are its own, carry its marker, and have a body", () => {
    const comments = [
      mine("mine-1", "N1"),
      null,
      { user: null, body: MARKER, node_id: "GHOST" },
      { user: { login: "someone-else" }, body: MARKER, node_id: "FOREIGN" },
      { user: { login: "octocat" }, body: "an unrelated comment", node_id: "UNRELATED" },
      { user: { login: "octocat" }, body: 12345, node_id: "NOTTEXT" },
      { user: { login: "octocat" }, node_id: "NOBODY" },
      mine("mine-2", "N2"),
    ];
    const { d, calls } = deps({ comments });
    post(d);
    expect(minimizes(calls).map((c) => c[c.indexOf("-F") + 1])).toEqual(["id=N1", "id=N2"]);
  });

  it("skips an older comment that has no node id instead of sending an empty one", () => {
    const { d, calls } = deps({ comments: [{ user: { login: "octocat" }, body: MARKER }, mine("B", "NODE_B")] });
    post(d);
    expect(minimizes(calls).map((c) => c[c.indexOf("-F") + 1])).toEqual(["id=NODE_B"]);
  });

  it("supersedes only the family named by markerPrefix", () => {
    const review = "<!-- review-complete verified-sha=";
    const comments = [mine("criteria", "CRIT"), { user: { login: "octocat" }, body: `${review}${SHA} -->`, node_id: "REVIEW" }];
    const { d, calls } = deps({ comments });
    post(d, { markerPrefix: review });
    expect(minimizes(calls).map((c) => c[c.indexOf("-F") + 1])).toEqual(["id=REVIEW"]);
  });

  it("posts before it hides anything, and never posts more than once", () => {
    const order = [];
    const d = {
      capture: (argv) => {
        if (argv[2] === "user") return "octocat";
        if (argv[2] === "graphql") {
          order.push("minimize");
          return "";
        }
        return JSON.stringify([mine("A", "NA"), mine("B", "NB")]);
      },
      ghApiWithInput: () => order.push("post"),
    };
    post(d);
    expect(order).toEqual(["post", "minimize", "minimize"]);
  });

  it("reads an empty listing as no older comments, and needs no logger", () => {
    const calls = [];
    const d = {
      capture: (argv) => {
        calls.push(argv);
        return argv[2] === "user" ? "octocat" : "";
      },
      ghApiWithInput: () => {},
    };
    expect(() => post(d)).not.toThrow();
    expect(minimizes(calls)).toEqual([]);
  });

  it("reports how many older comments it superseded", () => {
    const { d, logs } = deps({ comments: [mine("A", "NA"), mine("B", "NB")] });
    post(d);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("2");
  });
});
