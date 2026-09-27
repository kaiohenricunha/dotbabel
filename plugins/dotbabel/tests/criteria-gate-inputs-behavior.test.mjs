// Behavioral boundaries of `criteria/gate-inputs.mjs` (TEST-1, mutation floor 85).
//
// This module gathers every fact the merge gate's criteria rules judge, and most
// of what it decides is a refusal: an unreadable base, an unreadable file list,
// a spec that will not parse. `pr-stack-criteria.test.mjs` proves the headline
// security properties (base-ref reads, argv arrays, fail-closed on the main
// paths). This file adds the boundaries around them: the exact shape of each
// fail-closed answer, what counts as a commit id, how the spec listing is read,
// which rationale sections arm the downgrade, and what a comment page may look
// like before it is trusted.
//
// Everything runs in-process through an injected `run`, so there is no git, no
// network and no `gh` token. Assertions name outcomes a caller of the gate can
// observe; none of them depends on how the module reaches its answer.

import { describe, expect, it } from "vitest";

import { criteriaGateInputs, prComments, CRITERIA_CHECK_NAME } from "../src/criteria/gate-inputs.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BODY = "## Spec ID\n\nqa\n";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = () => ({ status: 128, stdout: "", stderr: "fatal" });
/** A failed command that still printed something. Its output must never be trusted. */
const failWith = (stdout) => ({ status: 1, stdout, stderr: "boom" });

const spec = (criteria, extra = {}) => ok(JSON.stringify({ acceptance_criteria: criteria, ...extra }));
const specAt = (sha, id) => `${sha}:docs/specs/${id}/spec.json`;

/**
 * An injected `run` that answers by command, records every argv, and throws on
 * anything unexpected so a stray call is a test failure rather than a silent
 * empty answer.
 */
function world({ readable = true, listing = ok(""), files = {}, config, graphql = [], checkRuns } = {}) {
  const calls = [];
  const pages = [...graphql];
  const run = (argv) => {
    calls.push(argv);
    const [cmd, sub, target] = argv;
    if (cmd === "git" && sub === "cat-file") return readable ? ok() : fail();
    if (cmd === "git" && sub === "ls-tree") return listing;
    if (cmd === "git" && sub === "show") {
      if (target.endsWith(":.dotbabel.json")) return config ?? fail();
      return files[target] ?? fail();
    }
    if (cmd === "gh" && sub === "api" && target === "graphql") {
      const next = pages.shift();
      if (next === undefined) throw new Error("unstubbed graphql page");
      return next;
    }
    if (cmd === "gh" && sub === "api") {
      if (checkRuns === undefined) throw new Error("unstubbed check-runs lookup");
      return checkRuns;
    }
    throw new Error(`unstubbed command: ${argv.join(" ")}`);
  };
  return { deps: { run }, calls, joined: () => calls.map((a) => a.join(" ")) };
}

const view = (over = {}) => ({ headRefOid: HEAD, baseRefOid: BASE, body: BODY, files: [], ...over });
const gate = (w, v = view(), opts = { comments: [] }) => criteriaGateInputs(w.deps, v, 7, opts);

/** One GraphQL page. */
const page = ({ nodes = [], hasNextPage = false, endCursor = "c1" } = {}) =>
  ok(JSON.stringify({ data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage, endCursor }, nodes } } } } }));

describe("what counts as a commit id", () => {
  const accepted = (headRefOid, baseRefOid = BASE) => {
    const w = world({ files: { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) } });
    return Object.keys(gate(w, view({ headRefOid, baseRefOid }))).length > 0;
  };

  it("accepts a 40-character hex id in either case", () => {
    expect(accepted(HEAD)).toBe(true);
    expect(accepted("ABCDEF0123456789abcdef0123456789ABCDEF01")).toBe(true);
  });

  it.each([
    ["39 characters", "a".repeat(39)],
    ["41 characters", "a".repeat(41)],
    ["a non-hex character", `${"a".repeat(39)}g`],
    ["a leading character outside the id", ` ${"a".repeat(40)}`],
    ["a trailing newline", `${"a".repeat(40)}\n`],
    ["a branch name", "main"],
    ["nothing", ""],
  ])("rejects a head id with %s, and never shells out for it", (_label, headRefOid) => {
    const w = world();
    expect(gate(w, view({ headRefOid }))).toEqual({});
    expect(w.calls).toEqual([]);
  });

  it("rejects a malformed base id just as it rejects a malformed head id", () => {
    const w = world();
    expect(gate(w, view({ baseRefOid: "b".repeat(39) }))).toEqual({});
    expect(gate(w, view({ baseRefOid: `${"b".repeat(39)}z` }))).toEqual({});
    expect(w.calls).toEqual([]);
  });

  it("answers with no criteria inputs, not an error, when the pull request view is missing", () => {
    // Called directly: the `gate` helper's default argument would replace an
    // `undefined` view with a valid one and test nothing.
    for (const missing of [undefined, null, {}]) {
      const w = world();
      expect(criteriaGateInputs(w.deps, missing, 7, { comments: [] })).toEqual({});
      expect(w.calls).toEqual([]);
    }
  });
});

describe("the fail-closed answers keep one exact shape", () => {
  // `checkMergeGate` reads these fields to decide, so a wrong default in any of
  // them is a different verdict, not a cosmetic difference.
  const closed = { requiredCriteria: {}, baseActiveCriteria: {}, unknownSpecIds: [], criteriaChangeRationale: false, comments: [], ciCriteriaCheck: null };

  it("an unprovable file list is reported as unreadable before any git call", () => {
    const w = world();
    expect(gate(w, view({ files: null }))).toEqual({ headRefOid: HEAD, ...closed, criteriaFilesUnreadable: true });
    expect(w.calls).toEqual([]);
  });

  it("an absent file list is not the same thing as an unprovable one", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) } });
    const result = gate(w, view({ files: undefined }));
    expect(result.criteriaFilesUnreadable).toBeUndefined();
    expect(result.requiredCriteria).toEqual({ qa: [] });
  });

  it("a base commit missing from the clone is reported with that commit, after one probe only", () => {
    const w = world({ readable: false });
    expect(gate(w)).toEqual({ headRefOid: HEAD, ...closed, criteriaBaseUnreadable: BASE });
    expect(w.calls).toHaveLength(1);
  });

  it("an unreadable base tree is reported the same way as a missing base commit", () => {
    const w = world({ listing: fail() });
    expect(gate(w, view({ files: [{ path: "src/a.js" }] }))).toEqual({ headRefOid: HEAD, ...closed, criteriaBaseUnreadable: BASE });
  });

  it("a spec listed at the base but unreadable there also fails closed", () => {
    const w = world({ listing: ok("docs/specs/one/spec.json\n"), files: {} });
    const result = gate(w, view({ files: [{ path: "src/a.js" }] }));
    expect(result.criteriaBaseUnreadable).toBe(BASE);
    expect(result.requiredCriteria).toEqual({});
  });

  it("declares nothing and touches nothing means nothing is in scope, with no git call", () => {
    const w = world();
    expect(gate(w, view({ body: "", files: [] }))).toEqual({});
    expect(w.calls).toEqual([]);
  });

  it("changing files that no spec covers, with no Spec ID, is still nothing in scope", () => {
    const w = world({ listing: ok("docs/specs/one/spec.json\n"), files: { [`${BASE}:docs/specs/one/spec.json`]: ok(JSON.stringify({ linked_paths: ["elsewhere/**"] })) } });
    expect(gate(w, view({ body: "", files: [{ path: "src/a.js" }] }))).toEqual({});
  });
});

describe("the changed-file list", () => {
  const covered = { listing: ok("docs/specs/one/spec.json\n"), files: { [specAt(BASE, "one")]: ok(JSON.stringify({ linked_paths: ["src/a.js"] })) } };

  it("keeps real paths and drops blank, missing and malformed entries", () => {
    const w = world(covered);
    const result = gate(w, view({ body: "", files: [null, {}, { path: "" }, { path: undefined }, { path: "src/a.js" }] }));
    expect(result.pathScopedSpecIds).toEqual(["one"]);
  });

  it("scopes to nothing when every entry is blank", () => {
    const w = world(covered);
    expect(gate(w, view({ body: "", files: [null, {}, { path: "" }] }))).toEqual({});
    expect(w.calls).toEqual([]);
  });
});

describe("reading the spec listing at the base", () => {
  const linked = ok(JSON.stringify({ linked_paths: ["src/**"] }));
  const changed = view({ body: "", files: [{ path: "src/a.js" }] });

  it("takes only top-level spec.json files, trimming stray whitespace and carriage returns", () => {
    const files = Object.fromEntries(["alpha", "beta", "gamma"].map((id) => [specAt(BASE, id), linked]));
    const w = world({
      files,
      listing: ok(
        [
          "docs/specs/alpha/spec.json",
          "  docs/specs/beta/spec.json  ",
          "docs/specs/gamma/spec.json\r",
          "docs/specs/nested/deeper/spec.json",
          "docs/specs/backup/spec.json.bak",
          "docs/specs/README.md",
          "other/docs/specs/outside/spec.json",
          "docs/specs/.hidden/spec.json",
          "docs/specs/-leading/spec.json",
          "",
        ].join("\n"),
      ),
    });
    expect(gate(w, changed).pathScopedSpecIds).toEqual(["alpha", "beta", "gamma"]);
    // A path the listing rejected is never read.
    const read = w.joined().filter((c) => c.startsWith("git show"));
    expect(read.some((c) => /nested|backup|outside|hidden|leading/.test(c))).toBe(false);
  });

  it("reads the listing at the base, from the repository root, for docs/specs only", () => {
    const w = world({ listing: ok("") });
    gate(w, changed);
    expect(w.calls.find((c) => c[1] === "ls-tree")).toEqual(["git", "ls-tree", "-r", "--full-tree", "--name-only", BASE, "--", "docs/specs/"]);
  });

  it("does not list at all when nothing changed", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) } });
    gate(w, view({ files: [] }));
    expect(w.calls.some((c) => c[1] === "ls-tree")).toBe(false);
  });
});

describe("deciding whether a changed file is governed by a spec", () => {
  const changed = view({ body: "", files: [{ path: "src/a.js" }] });
  const governed = (linked_paths) => {
    const w = world({
      listing: ok("docs/specs/one/spec.json\n"),
      files: { [specAt(BASE, "one")]: ok(JSON.stringify({ linked_paths })), [specAt(HEAD, "one")]: spec([]) },
    });
    return gate(w, changed).pathScopedSpecIds ?? [];
  };

  it("matches a linked pattern that covers the changed file", () => {
    expect(governed(["src/**"])).toEqual(["one"]);
    expect(governed(["docs/**", "src/a.js"])).toEqual(["one"]);
  });

  it("ignores entries that are not strings, and still honours the ones that are", () => {
    expect(governed([123, null, { path: "src/a.js" }, "src/**"])).toEqual(["one"]);
    expect(governed([123, null])).toEqual([]);
  });

  it("does not match a spec that links nothing, links something else, or has no list at all", () => {
    expect(governed([])).toEqual([]);
    expect(governed(["elsewhere/**"])).toEqual([]);
    expect(governed(undefined)).toEqual([]);
    expect(governed("src/**")).toEqual([]);
    expect(governed({ 0: "src/**" })).toEqual([]);
  });

  it("skips a spec that does not parse at the base rather than blocking every pull request", () => {
    const w = world({
      listing: ok("docs/specs/broken/spec.json\ndocs/specs/one/spec.json\n"),
      files: { [specAt(BASE, "broken")]: ok("{ not json"), [specAt(BASE, "one")]: ok(JSON.stringify({ linked_paths: ["src/**"] })), [specAt(HEAD, "one")]: spec([]) },
    });
    const result = gate(w, changed);
    expect(result.pathScopedSpecIds).toEqual(["one"]);
    expect(result.criteriaBaseUnreadable).toBeUndefined();
  });

  it("unions the ids the body declares with the ones the diff implicates, each once", () => {
    const w = world({
      listing: ok("docs/specs/qa/spec.json\ndocs/specs/other/spec.json\n"),
      files: {
        [specAt(BASE, "qa")]: ok(JSON.stringify({ linked_paths: ["src/**"], acceptance_criteria: [{ id: "AC-1" }] })),
        [specAt(BASE, "other")]: ok(JSON.stringify({ linked_paths: ["src/**"], acceptance_criteria: [] })),
        [specAt(HEAD, "qa")]: spec([{ id: "AC-1" }]),
        [specAt(HEAD, "other")]: spec([]),
      },
    });
    const result = gate(w, view({ body: BODY, files: [{ path: "src/a.js" }] }));
    expect(Object.keys(result.requiredCriteria).sort()).toEqual(["other", "qa"]);
    expect(result.pathScopedSpecIds.sort()).toEqual(["other", "qa"]);
    expect(result.unknownSpecIds).toEqual([]);
  });
});

describe("the active criteria a spec declares at each ref", () => {
  it("treats a criterion with no status as active and drops planned ones and empty entries", () => {
    const w = world({
      files: {
        [specAt(HEAD, "qa")]: spec([{ id: "AC-1" }, { id: "AC-2", status: "active" }, { id: "AC-3", status: "planned" }, null, { id: "AC-4" }]),
        [specAt(BASE, "qa")]: spec([{ id: "AC-1", status: "planned" }, { id: "AC-2" }]),
      },
    });
    const result = gate(w);
    expect(result.requiredCriteria).toEqual({ qa: ["AC-1", "AC-2", "AC-4"] });
    expect(result.baseActiveCriteria).toEqual({ qa: ["AC-2"] });
  });

  it("reads a spec with no acceptance_criteria as having nothing to prove, which is not absence", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: ok(JSON.stringify({ id: "qa" })), [specAt(BASE, "qa")]: ok(JSON.stringify({ id: "qa" })) } });
    const result = gate(w);
    expect(result.requiredCriteria).toEqual({ qa: [] });
    expect(result.baseActiveCriteria).toEqual({ qa: [] });
    expect(result.unknownSpecIds).toEqual([]);
  });

  it("a spec new in the pull request has head criteria and no base entry", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: spec([{ id: "AC-1" }]) } });
    const result = gate(w);
    expect(result.requiredCriteria).toEqual({ qa: ["AC-1"] });
    expect(result.baseActiveCriteria).toEqual({});
  });

  it("a declared spec that is absent, unreadable or unparseable at the head is unknown", () => {
    for (const reply of [undefined, fail(), ok("{ not json")]) {
      const w = world({ files: reply === undefined ? {} : { [specAt(HEAD, "qa")]: reply } });
      const result = gate(w);
      expect(result.unknownSpecIds).toEqual(["qa"]);
      expect(result.requiredCriteria).toEqual({});
    }
  });

  it("a failed read is never trusted, even when the command printed a valid spec", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: failWith(JSON.stringify({ acceptance_criteria: [{ id: "AC-1" }] })) } });
    const result = gate(w);
    expect(result.requiredCriteria).toEqual({});
    expect(result.unknownSpecIds).toEqual(["qa"]);
  });

  it("does not report an id the diff pulled in as unknown when it is absent at the head, but does keep its base criteria", () => {
    const w = world({
      listing: ok("docs/specs/gone/spec.json\n"),
      files: { [specAt(BASE, "gone")]: ok(JSON.stringify({ linked_paths: ["src/**"], acceptance_criteria: [{ id: "AC-9" }] })) },
    });
    const result = gate(w, view({ body: "", files: [{ path: "src/a.js" }] }));
    expect(result.unknownSpecIds).toEqual([]);
    expect(result.baseActiveCriteria).toEqual({ gone: ["AC-9"] });
    expect(result.pathScopedSpecIds).toEqual(["gone"]);
  });

  it("names the base commit in every base-ref read, and the head commit in every head-ref read", () => {
    const w = world({ files: { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) } });
    gate(w);
    expect(w.calls).toContainEqual(["git", "show", specAt(HEAD, "qa")]);
    expect(w.calls).toContainEqual(["git", "show", specAt(BASE, "qa")]);
    expect(w.calls).toContainEqual(["git", "show", `${BASE}:.dotbabel.json`]);
    expect(w.calls).toContainEqual(["git", "cat-file", "-e", `${BASE}^{commit}`]);
  });
});

describe("the configuration is read from the base ref", () => {
  const files = { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) };

  it("uses the defaults when the base has no configuration, however much a failed read printed", () => {
    for (const config of [undefined, fail(), failWith('{"criteria":{"enforcement":"warn"}}')]) {
      const result = gate(world({ files, config }));
      expect(result.criteriaEnforcement).toBe("block");
      expect(result.requireCiCheck).toBe(false);
      expect(result.trustedAssociations).toEqual(["OWNER"]);
    }
  });

  it("carries the configured values through to the gate", () => {
    const config = ok(JSON.stringify({ criteria: { enforcement: "warn", trusted_associations: ["OWNER", "MEMBER"], require_ci_check: false } }));
    const result = gate(world({ files, config }));
    expect(result.criteriaEnforcement).toBe("warn");
    expect(result.trustedAssociations).toEqual(["OWNER", "MEMBER"]);
  });

  it("names the base ref in the error when the configuration there is not JSON", () => {
    const error = (() => {
      try {
        gate(world({ files, config: ok("{ not json") }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error?.code).toBe("CRITERIA_CONFIG_INVALID");
    expect(error?.file).toBe(`${BASE}:.dotbabel.json`);
  });
});

describe("which rationale section arms the downgrade", () => {
  const rationale = (tail) => gate(world({ files: { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) } }), view({ body: `${BODY}\n${tail}` })).criteriaChangeRationale;

  it.each([
    ["a heading with text under it", "## Criteria change rationale\n\nremoved AC-3 because it duplicates AC-2\n"],
    ["the heading in any letter case", "## criteria CHANGE Rationale\nreason\n"],
    ["a heading indented by up to three spaces", "   ## Criteria change rationale\nreason\n"],
    ["a tab after the hashes", "##\tCriteria change rationale\nreason\n"],
    ["several spaces after the hashes", "##   Criteria change rationale\nreason\n"],
    ["a mix of spaces and tabs after the hashes", "## \t Criteria change rationale\nreason\n"],
    ["trailing spaces on the heading", "## Criteria change rationale   \nreason\n"],
    ["a section that runs to the end of the body with no final newline", "## Criteria change rationale\nreason"],
    ["a section closed by the next H2", "## Criteria change rationale\nreason\n## Notes\nother\n"],
    ["text after an HTML comment", "## Criteria change rationale\n<!-- template hint -->\nreason\n"],
    ["text between two HTML comments", "## Criteria change rationale\n<!-- a --> real reason <!-- b -->\n"],
    ["text after a multi-line HTML comment", "## Criteria change rationale\n<!--\nfill in\nthis section\n-->\nreason\n"],
    ["an indented line that only looks like the next heading", "## Criteria change rationale\n    ## Notes\n"],
    ["an H3, which does not end the section", "## Criteria change rationale\n### Detail\nwhy\n"],
  ])("arms it for %s", (_label, tail) => {
    expect(rationale(tail)).toBe(true);
  });

  it.each([
    ["a bare heading", "## Criteria change rationale\n"],
    ["a heading followed only by blank lines", "## Criteria change rationale\n\n   \n\t\n"],
    ["a heading followed only by one HTML comment", "## Criteria change rationale\n<!-- fill this in -->\n"],
    ["a heading followed only by several HTML comments", "## Criteria change rationale\n<!-- a -->\n\n<!-- b -->\n"],
    ["an empty section whose neighbour has content", "## Criteria change rationale\n## Notes\nlots of unrelated text\n"],
    ["an empty section closed by an indented H2", "## Criteria change rationale\n  ## Notes\ntext\n"],
    ["a heading indented four spaces, which is a code block", "    ## Criteria change rationale\nreason\n"],
    ["an H3", "### Criteria change rationale\nreason\n"],
    ["a heading with extra words", "## Criteria change rationale and more\nreason\n"],
    ["no space after the hashes", "##Criteria change rationale\nreason\n"],
    ["plain text with no heading", "Criteria change rationale\nreason\n"],
    ["a heading quoted inside a code fence", "```\n## Criteria change rationale\nreason\n```\n"],
    ["no section at all", "## Notes\nnothing here\n"],
  ])("does not arm it for %s", (_label, tail) => {
    expect(rationale(tail)).toBe(false);
  });
});

describe("comments handed in by the caller", () => {
  const files = { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) };

  it("uses the list it was given and fetches nothing", () => {
    const given = [{ body: "b", authorAssociation: "OWNER", authorLogin: "x", lastEditedAt: null }];
    const w = world({ files });
    expect(criteriaGateInputs(w.deps, view(), 7, { comments: given }).comments).toBe(given);
    expect(w.calls.some((c) => c[2] === "graphql")).toBe(false);
  });

  it("honours an explicit null, which means the caller could not read them", () => {
    const w = world({ files });
    expect(criteriaGateInputs(w.deps, view(), 7, { comments: null }).comments).toBeNull();
    expect(w.calls.some((c) => c[2] === "graphql")).toBe(false);
  });

  it("fetches them itself when the caller passed none, or passed no options at all", () => {
    for (const call of [(w) => criteriaGateInputs(w.deps, view(), 7, {}), (w) => criteriaGateInputs(w.deps, view(), 7)]) {
      const w = world({ files, graphql: [page({ nodes: [{ body: "fetched", authorAssociation: "OWNER", author: { login: "o" } }] })] });
      expect(call(w).comments).toEqual([{ body: "fetched", authorAssociation: "OWNER", authorLogin: "o", lastEditedAt: null }]);
    }
  });
});

describe("prComments", () => {
  const first = (w) => w.calls.find((c) => c[2] === "graphql");
  const queryOf = (argv) => argv.find((a) => a.startsWith("query="));

  it("asks GraphQL for the repository placeholders, the pull request number and the query, and no cursor on the first page", () => {
    const w = world({ graphql: [page()] });
    prComments(w.deps, 7);
    const argv = first(w);
    expect(argv.slice(0, 9)).toEqual(["gh", "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", "number=7"]);
    expect(argv.some((a) => a.startsWith("cursor="))).toBe(false);
    expect(argv.at(-2)).toBe("-f");
    expect(argv.at(-1)).toMatch(/^query=/);
  });

  it("asks for every field the parser later reads, so a dropped field cannot silently disable a check", () => {
    const w = world({ graphql: [page()] });
    prComments(w.deps, 7);
    const query = queryOf(first(w)).slice("query=".length);
    for (const needle of ["body", "authorAssociation", "lastEditedAt", "author{login}", "pageInfo{hasNextPage endCursor}"]) {
      expect(query, `the query no longer requests ${needle}`).toContain(needle);
    }
    // The variables it declares are the ones the argv supplies.
    for (const variable of ["$owner:String!", "$repo:String!", "$number:Int!", "$cursor:String"]) expect(query).toContain(variable);
    expect(query).toContain("repository(owner:$owner,name:$repo)");
    expect(query).toContain("pullRequest(number:$number)");
    expect(query).toContain("comments(first:100,after:$cursor)");
    expect(query.startsWith("query(")).toBe(true);
    expect((query.match(/{/g) ?? []).length).toBe((query.match(/}/g) ?? []).length);
  });

  it("nests each selection directly inside the previous one, with nothing between the pieces", () => {
    // The query is assembled from pieces. Anything joined between them is text
    // GraphQL would reject, and the failure would surface only as an unexplained
    // "could not read comments" on a live pull request.
    const w = world({ graphql: [page()] });
    prComments(w.deps, 7);
    const query = queryOf(first(w)).slice("query=".length);
    expect(query).toContain("$cursor:String){repository(");
    expect(query).toContain("$repo){pullRequest(");
    expect(query).toContain("after:$cursor){pageInfo{hasNextPage endCursor}nodes{");
    expect(query.endsWith("}}}}")).toBe(true);
  });

  it("passes the cursor as text on later pages, before the query", () => {
    const w = world({ graphql: [page({ hasNextPage: true, endCursor: "12345" }), page({ hasNextPage: false })] });
    prComments(w.deps, 7);
    const pages = w.calls.filter((c) => c[2] === "graphql");
    expect(pages).toHaveLength(2);
    const second = pages[1];
    expect(second).toContain("cursor=12345");
    expect(second[second.indexOf("cursor=12345") - 1]).toBe("-f");
    expect(second.indexOf("cursor=12345")).toBeLessThan(second.findIndex((a) => a.startsWith("query=")));
  });

  it("maps a node to the fields the gate needs, defaulting what is missing", () => {
    const w = world({
      graphql: [
        page({
          nodes: [
            { body: "hello", authorAssociation: "OWNER", lastEditedAt: "2026-01-01T00:00:00Z", author: { login: "octocat" } },
            {},
            { body: "ghost", author: null },
            { body: "no login", author: {} },
          ],
        }),
      ],
    });
    expect(prComments(w.deps, 7)).toEqual([
      { body: "hello", authorAssociation: "OWNER", authorLogin: "octocat", lastEditedAt: "2026-01-01T00:00:00Z" },
      { body: "", authorAssociation: "", authorLogin: null, lastEditedAt: null },
      { body: "ghost", authorAssociation: "", authorLogin: null, lastEditedAt: null },
      { body: "no login", authorAssociation: "", authorLogin: null, lastEditedAt: null },
    ]);
  });

  it("returns an empty list, not null, for a pull request with no comments and no node list", () => {
    const empty = ok(JSON.stringify({ data: { repository: { pullRequest: { comments: {} } } } }));
    expect(prComments(world({ graphql: [empty] }).deps, 7)).toEqual([]);
    expect(prComments(world({ graphql: [page({ nodes: [] })] }).deps, 7)).toEqual([]);
  });

  it("stops after a page that names no next page, including one with no page info at all", () => {
    const noInfo = ok(JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [{ body: "only" }] } } } } }));
    const w = world({ graphql: [noInfo] });
    expect(prComments(w.deps, 7)).toHaveLength(1);
    expect(w.calls.filter((c) => c[2] === "graphql")).toHaveLength(1);
  });

  it("keeps collecting across pages, in order", () => {
    const w = world({ graphql: [page({ nodes: [{ body: "one" }], hasNextPage: true, endCursor: "c1" }), page({ nodes: [{ body: "two" }] })] });
    expect(prComments(w.deps, 7).map((c) => c.body)).toEqual(["one", "two"]);
  });

  it("returns null, never a partial list, when any later page fails", () => {
    const w = world({ graphql: [page({ nodes: [{ body: "one" }], hasNextPage: true }), fail()] });
    expect(prComments(w.deps, 7)).toBeNull();
  });

  it("does not trust output from a failed request", () => {
    expect(prComments(world({ graphql: [failWith(page({ nodes: [{ body: "x" }] }).stdout)] }).deps, 7)).toBeNull();
  });

  it.each([
    ["a JSON null", "null"],
    ["an empty object", "{}"],
    ["no repository", JSON.stringify({ data: null })],
    ["a null repository", JSON.stringify({ data: { repository: null } })],
    ["a null pull request", JSON.stringify({ data: { repository: { pullRequest: null } } })],
    ["a pull request with no comments connection", JSON.stringify({ data: { repository: { pullRequest: {} } } })],
    ["a page that is not JSON", "{ not json"],
  ])("returns null for %s rather than throwing", (_label, stdout) => {
    expect(prComments(world({ graphql: [ok(stdout)] }).deps, 7)).toBeNull();
  });

  it("returns null for a GraphQL error delivered with a success status, but ignores an empty error list", () => {
    const withErrors = (errors) => ok(JSON.stringify({ errors, data: { repository: { pullRequest: { comments: { nodes: [{ body: "kept" }], pageInfo: { hasNextPage: false } } } } } }));
    expect(prComments(world({ graphql: [withErrors([{ message: "rate limited" }])] }).deps, 7)).toBeNull();
    expect(prComments(world({ graphql: [withErrors([])] }).deps, 7)).toHaveLength(1);
  });
});

describe("the criteria check run", () => {
  const files = { [specAt(HEAD, "qa")]: spec([]), [specAt(BASE, "qa")]: spec([]) };
  const requiring = ok(JSON.stringify({ criteria: { require_ci_check: true } }));
  const conclusion = (checkRuns) => gate(world({ files, config: requiring, checkRuns })).ciCriteriaCheck;
  const runs = (list) => ok(JSON.stringify({ check_runs: list }));

  it("is not looked up at all unless the configuration requires it", () => {
    const w = world({ files });
    expect(gate(w).ciCriteriaCheck).toBeNull();
    expect(w.calls.some((c) => c.join(" ").includes("check-runs"))).toBe(false);
  });

  it("asks for the head commit's check runs in one page, without --paginate", () => {
    const w = world({ files, config: requiring, checkRuns: runs([]) });
    gate(w);
    expect(w.calls).toContainEqual(["gh", "api", `repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100`]);
    expect(w.calls.flat()).not.toContain("--paginate");
  });

  it("answers with the conclusion of the run carrying the criteria name, newest first", () => {
    expect(conclusion(runs([{ name: CRITERIA_CHECK_NAME, conclusion: "failure" }, { name: "lint", conclusion: "success" }, { name: CRITERIA_CHECK_NAME, conclusion: "success" }]))).toBe("success");
  });

  it("answers null for a run that has not concluded, an unnamed list, or no matching run", () => {
    expect(conclusion(runs([{ name: CRITERIA_CHECK_NAME }]))).toBeNull();
    expect(conclusion(runs([{ name: CRITERIA_CHECK_NAME, conclusion: null }]))).toBeNull();
    expect(conclusion(runs([{ name: "lint", conclusion: "success" }]))).toBeNull();
    expect(conclusion(runs([]))).toBeNull();
    expect(conclusion(ok(JSON.stringify({})))).toBeNull();
  });

  it("skips empty entries in the list instead of throwing on them", () => {
    expect(conclusion(runs([null, { name: CRITERIA_CHECK_NAME, conclusion: "success" }, null]))).toBe("success");
  });

  it("answers null when the lookup fails, returns something unreadable, or fails while printing a valid answer", () => {
    expect(conclusion(fail())).toBeNull();
    expect(conclusion(ok("{ not json"))).toBeNull();
    expect(conclusion(failWith(JSON.stringify({ check_runs: [{ name: CRITERIA_CHECK_NAME, conclusion: "success" }] })))).toBeNull();
  });
});
