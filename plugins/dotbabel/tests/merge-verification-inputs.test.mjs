// merge-verification-inputs — the GitHub and git reads behind spot-check,
// main-status and contradiction, driven through a recording `deps.run`.
//
// Each case pins one rule of the gather: argv only, never a shell string;
// "could not read" stays unknown and never becomes an empty answer; the trust
// list comes from the revision asked for and never falls back to another one;
// and in CI only an issue the workflow opened can stop a new one.

import { describe, it, expect } from "vitest";

import {
  InputError,
  ciAvailability,
  classifyWorkflowRun,
  defaultBranch,
  firstParentHistory,
  ghApiJson,
  labelContradicted,
  mergedPullFor,
  openContradictionIssue,
  prChangedPaths,
  readPrHead,
  trunkCommits,
  trustListAt,
  workflowRunsFor,
} from "../src/merge-verification-inputs.mjs";
import { failingCommitMarker } from "../src/merge-verification.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const no = (stderr = "boom") => ({ status: 1, stdout: "", stderr });

/**
 * A recording `deps.run`: answers from the first route whose regex matches the
 * joined argv, and fails anything unrouted, as an unreachable API would.
 */
function recorder(routes) {
  const calls = [];
  const posts = [];
  const run = (argv) => {
    calls.push(argv);
    const joined = argv.join(" ");
    const hit = routes.find(([re]) => re.test(joined));
    return hit ? hit[1] : no(`unrouted: ${joined}`);
  };
  const post = (argv, body) => {
    posts.push({ argv, body });
    return { number: 41, html_url: "https://example.test/issues/41" };
  };
  return { deps: { run, post }, calls, posts };
}

const red = { id: 7, status: "completed", conclusion: "failure", head_sha: C1 };
const failedJob = { id: 1, conclusion: "failure", steps: [{ number: 1 }] };
const neverStarted = { id: 1, conclusion: "failure", runner_name: "", steps: [] };

describe("ghApiJson", () => {
  it("parses a response, and reads a failure or bad JSON as null, never as empty", () => {
    expect(ghApiJson(recorder([[/x/, ok({ a: 1 })]]).deps, "x")).toEqual({ a: 1 });
    expect(ghApiJson(recorder([[/x/, no()]]).deps, "x")).toBeNull();
    expect(ghApiJson(recorder([[/x/, ok("not json")]]).deps, "x")).toBeNull();
  });
});

describe("readPrHead and defaultBranch", () => {
  it("reads the head of a pull request and refuses one without a full SHA", () => {
    const { deps, calls } = recorder([[/^gh pr view 7 /, ok({ headRefOid: SHA, baseRefOid: OTHER })]]);
    expect(readPrHead(deps, 7, "headRefOid,baseRefOid")).toEqual({ view: { headRefOid: SHA, baseRefOid: OTHER }, headSha: SHA });
    expect(calls[0]).toEqual(["gh", "pr", "view", "7", "--json", "headRefOid,baseRefOid"]);
    expect(() => readPrHead(recorder([[/pr view/, ok({ headRefOid: "x" })]]).deps, 7, "headRefOid")).toThrow(InputError);
    expect(() => readPrHead(recorder([]).deps, 7, "headRefOid")).toThrow(/could not read #7/);
  });

  it("reads the default branch from gh, and makes an unreadable one an env error", () => {
    const { deps, calls } = recorder([[/^gh repo view /, ok("develop\n")]]);
    expect(defaultBranch(deps)).toBe("develop");
    expect(calls[0]).toEqual(["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
    const err = (() => {
      try {
        defaultBranch(recorder([[/repo view/, ok("bad name;\n")]]).deps);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(InputError);
    expect(err.code).toBe("env");
  });
});

describe("prChangedPaths", () => {
  const filesRe = /--jq \.\[\]\.filename$/;
  const renamesRe = /previous_filename/;

  it("adds the old path of each renamed file to the changed paths", () => {
    const { deps, calls } = recorder([
      [filesRe, ok("src/session.js\nREADME.md\n")],
      [renamesRe, ok("src/auth/session.js\n")],
    ]);
    expect(prChangedPaths(deps, 7, 2)).toEqual(["src/session.js", "README.md", "src/auth/session.js"]);
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["gh", "api", "repos/{owner}/{repo}/pulls/7/files"],
      ["gh", "api", "repos/{owner}/{repo}/pulls/7/files"],
    ]);
  });

  it("is null when either list cannot be read or the count does not match", () => {
    expect(prChangedPaths(recorder([[renamesRe, ok("")]]).deps, 7, 1)).toBeNull();
    expect(prChangedPaths(recorder([[filesRe, ok("a\n")]]).deps, 7, 1)).toBeNull();
    expect(prChangedPaths(recorder([[filesRe, ok("a\n")], [renamesRe, ok("")]]).deps, 7, 2)).toBeNull();
    expect(prChangedPaths(recorder([[filesRe, ok("a\n")], [renamesRe, ok("")]]).deps, 7, 3000)).toBeNull();
  });
});

describe("classifyWorkflowRun", () => {
  it("takes a successful run at its word without reading its jobs", () => {
    const { deps, calls } = recorder([]);
    expect(classifyWorkflowRun(deps, { id: 7, status: "completed", conclusion: "success" })).toBe("green");
    expect(calls).toEqual([]);
  });

  it("reads the jobs of any other run, and never an annotation", () => {
    const { deps, calls } = recorder([[/runs\/7\/jobs/, ok({ total_count: 1, jobs: [failedJob] })]]);
    expect(classifyWorkflowRun(deps, red)).toBe("red");
    expect(calls).toEqual([["gh", "api", "repos/{owner}/{repo}/actions/runs/7/jobs?per_page=100"]]);
    expect(classifyWorkflowRun(recorder([[/jobs/, ok({ jobs: [neverStarted] })]]).deps, red)).toBe("unverified");
  });

  it("is unknown when the run or its jobs cannot be read, or the jobs list is incomplete", () => {
    expect(classifyWorkflowRun(recorder([]).deps, null)).toBe("unknown");
    expect(classifyWorkflowRun(recorder([]).deps, red)).toBe("unknown");
    expect(classifyWorkflowRun(recorder([[/jobs/, ok({ total_count: 101, jobs: [neverStarted] })]]).deps, red)).toBe("unknown");
    // A red found in the first page stands, complete or not.
    expect(classifyWorkflowRun(recorder([[/jobs/, ok({ total_count: 101, jobs: [failedJob] })]]).deps, red)).toBe("red");
  });
});

describe("trunkCommits and firstParentHistory", () => {
  const log = ok(`${C1}\tfeat: one (#5)\n${C2}\tchore: no number\n`);

  it("reads first-parent commits newest first, with the pull request from the subject", () => {
    const { deps, calls } = recorder([[/^git fetch/, ok()], [/^git log/, log]]);
    expect(trunkCommits(deps, { remote: "origin", trunk: "main", limit: 2 })).toEqual({
      ref: "origin/main",
      fetched: true,
      commits: [
        { sha: C1, pr: 5, subject: "feat: one (#5)" },
        { sha: C2, pr: null, subject: "chore: no number" },
      ],
    });
    expect(calls[1]).toEqual(["git", "log", "--first-parent", "-n2", "--format=%H%x09%s", "origin/main^{commit}", "--"]);
    expect(firstParentHistory(recorder([[/^git log/, log]]).deps, C1, 21).map((c) => c.sha)).toEqual([C1, C2]);
  });

  it("makes a malformed ref a usage error and an unreadable one an env error", () => {
    expect(() => trunkCommits(recorder([]).deps, { remote: "origin", trunk: "main;rm", limit: 1 })).toThrow(/plain ref name/);
    let err;
    try {
      trunkCommits(recorder([[/^git fetch/, no()]]).deps, { remote: "origin", trunk: "main", limit: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "env" });
    expect(() => firstParentHistory(recorder([]).deps, "HEAD", 1)).toThrow(/full 40-character SHA/);
    expect(() => firstParentHistory(recorder([]).deps, C1, 1)).toThrow(/fetch more history/);
  });
});

describe("ciAvailability", () => {
  const runs = (list) => [/runs\?branch=main&status=completed&per_page=1$/, ok({ workflow_runs: list })];

  it("classifies the newest completed run only when it tested a recent commit", () => {
    const { deps, calls } = recorder([runs([red]), [/runs\/7\/jobs/, ok({ jobs: [failedJob] })]]);
    expect(ciAvailability(deps, { workflow: "test.yml", trunk: "main", recentShas: [C1, C2] })).toMatchObject({
      state: "available",
      run: { id: 7, headSha: C1, classification: "red" },
    });
    expect(calls).toHaveLength(2);
    const old = recorder([runs([{ ...red, head_sha: OTHER }])]);
    expect(ciAvailability(old.deps, { workflow: "test.yml", trunk: "main", recentShas: [C1] })).toMatchObject({
      state: "unavailable",
      run: { classification: "not read" },
    });
    // Out of range: the jobs are never read.
    expect(old.calls).toHaveLength(1);
  });

  it("is unknown when the runs or the recent commits cannot be read, and refuses a bad workflow", () => {
    expect(ciAvailability(recorder([]).deps, { workflow: "test.yml", trunk: "main", recentShas: [C1] }).state).toBe("unknown");
    expect(ciAvailability(recorder([runs([red])]).deps, { workflow: "test.yml", trunk: "main", recentShas: null }).state).toBe("unknown");
    expect(() => ciAvailability(recorder([]).deps, { workflow: "../x", trunk: "main", recentShas: [C1] })).toThrow(InputError);
  });
});

describe("workflowRunsFor", () => {
  const list = [/runs\?branch=main&per_page=100$/, ok({ workflow_runs: [red, { id: 8, status: "completed", conclusion: "success", head_sha: C2 }, { ...red, head_sha: OTHER }] })];

  it("classifies the runs of the wanted commits only, and only those asked for", () => {
    const { deps, calls } = recorder([list, [/runs\/7\/jobs/, ok({ jobs: [failedJob] })]]);
    expect(workflowRunsFor(deps, { workflow: "test.yml", trunk: "main", shas: [C1, C2] })).toEqual([
      { headSha: C1, state: "red" },
      { headSha: C2, state: "green" },
    ]);
    expect(calls).toHaveLength(2);
    const lazy = recorder([list]);
    expect(workflowRunsFor(lazy.deps, { workflow: "test.yml", trunk: "main", shas: [C1, C2], classify: () => false })).toEqual([
      { headSha: C1, state: "unverified" },
      { headSha: C2, state: "green" },
    ]);
    expect(lazy.calls).toHaveLength(1);
  });

  it("is null when the runs list cannot be read", () => {
    expect(workflowRunsFor(recorder([]).deps, { workflow: "test.yml", trunk: "main", shas: [C1] })).toBeNull();
  });
});

describe("trustListAt", () => {
  const resolve = [/^git rev-parse --verify --quiet /, ok(`${SHA}\n`)];
  const exists = [/^git cat-file -e /, ok()];

  it("reads the trust list at the revision asked for, and names its source", () => {
    const { deps, calls } = recorder([resolve, exists, [/^git show /, ok({ attestation: { trusted_associations: ["OWNER", "MEMBER"] } })]]);
    expect(trustListAt(deps, `${C1}^1`, "first parent")).toEqual({ list: ["OWNER", "MEMBER"], source: `.dotbabel.json at the first parent ${SHA.slice(0, 8)}` });
    expect(calls.map((c) => c.join(" "))).toEqual([
      `git rev-parse --verify --quiet ${C1}^1^{commit}`,
      `git cat-file -e ${SHA}^{commit}`,
      `git show ${SHA}:.dotbabel.json`,
    ]);
  });

  it("uses the default OWNER list when the revision has no config or no list", () => {
    expect(trustListAt(recorder([resolve, exists, [/^git show /, no()]]).deps, "x", "first parent")).toEqual({
      list: ["OWNER"],
      source: `default OWNER (the first parent ${SHA.slice(0, 8)} has no .dotbabel.json)`,
    });
    expect(trustListAt(recorder([resolve, exists, [/^git show /, ok({ attestation: {} })]]).deps, "x", "first parent").source).toMatch(
      /sets no trusted_associations/,
    );
  });

  it("throws, never falling back, when the revision cannot be read or its config does not parse", () => {
    expect(() => trustListAt(recorder([]).deps, "x", "first parent")).toThrow(/cannot read the first parent/);
    expect(() => trustListAt(recorder([resolve, exists, [/^git show /, ok("{ nope")]]).deps, "x", "first parent")).toThrow(
      /trust list at the first parent/,
    );
  });
});

describe("mergedPullFor", () => {
  it("finds the pull request merged as the commit, or none", () => {
    const pulls = [/commits\/1+\/pulls$/, ok([{ number: 3, merge_commit_sha: OTHER }, { number: 5, merge_commit_sha: C1, head: { sha: SHA } }])];
    expect(mergedPullFor(recorder([pulls]).deps, C1)).toEqual({ number: 5, headSha: SHA });
    expect(mergedPullFor(recorder([[/pulls$/, ok([])]]).deps, C1)).toBeNull();
  });

  it("is an env error when the list or the pull request cannot be read", () => {
    expect(() => mergedPullFor(recorder([]).deps, C1)).toThrow(/could not read/);
    expect(() => mergedPullFor(recorder([[/pulls$/, ok([{ number: 5, merge_commit_sha: C1 }])]]).deps, C1)).toThrow(/no readable/);
  });
});

describe("labelContradicted and openContradictionIssue", () => {
  const issue = { title: "t", body: "b", labels: ["attestation-contradicted"] };
  const marker = failingCommitMarker(C1);
  const listed = (issues) => [/^gh issue list /, ok(issues)];

  it("creates the label when it is missing, then labels the pull request", () => {
    const { deps, posts } = recorder([[/labels\/attestation-contradicted$/, no("HTTP 404")]]);
    labelContradicted(deps, 7);
    expect(posts.map((p) => p.argv.join(" "))).toEqual([
      "gh api --method POST repos/{owner}/{repo}/labels --input -",
      "gh api --method POST repos/{owner}/{repo}/issues/7/labels --input -",
    ]);
  });

  it("opens one issue when none carries the marker", () => {
    const { deps, posts } = recorder([listed([{ number: 3, body: "other", state: "OPEN", author: { login: "app/github-actions" } }])]);
    expect(openContradictionIssue(deps, { issue, marker, workflowOnly: true })).toEqual({
      number: 41,
      url: "https://example.test/issues/41",
      created: true,
      reopened: false,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe(issue);
  });

  it("reopens a closed issue with a comment, and accepts only the workflow's issue in CI", () => {
    const closed = { number: 12, body: marker, state: "CLOSED", author: { login: "github-actions[bot]" } };
    const { deps, calls, posts } = recorder([listed([closed]), [/^gh issue reopen 12 --comment /, ok()]]);
    expect(openContradictionIssue(deps, { issue, marker, workflowOnly: true })).toMatchObject({ number: 12, created: false, reopened: true });
    expect(calls.at(-1).slice(0, 5)).toEqual(["gh", "issue", "reopen", "12", "--comment"]);
    expect(posts).toHaveLength(0);
    const planted = recorder([listed([{ ...closed, author: { login: "owner" } }])]);
    expect(openContradictionIssue(planted.deps, { issue, marker, workflowOnly: true })).toMatchObject({ created: true });
    // Outside CI, any author counts: the user runs it on their own repository.
    const local = recorder([listed([{ ...closed, state: "OPEN", author: { login: "owner" } }])]);
    expect(openContradictionIssue(local.deps, { issue, marker, workflowOnly: false })).toMatchObject({ number: 12, created: false, reopened: false });
  });

  it("throws when the issue list cannot be read, so a failure to post is never silent", () => {
    expect(() => openContradictionIssue(recorder([]).deps, { issue, marker, workflowOnly: true })).toThrow(/could not list/);
    expect(() => openContradictionIssue(recorder([listed("nope")]).deps, { issue, marker, workflowOnly: true })).toThrow(/could not parse/);
  });
});
