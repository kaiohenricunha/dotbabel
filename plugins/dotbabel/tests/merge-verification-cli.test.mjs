// `dotbabel pr-stack spot-check | main-status | contradiction` — the wiring.
//
// The decisions are unit-tested in merge-verification.test.mjs. These tests
// drive the real bin against a throwaway git repository and a fake `gh` that
// answers from a route table, so they pin what the decisions are fed: the
// policy from the BASE commit, the changed files, the default-branch CI run,
// the pull request a commit was merged from, and its comments. They also pin
// the writes: the receipt entry, the label, and exactly one issue.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { buildAttestationPayload, renderAttestationHeader } from "../src/attestation.mjs";
import { contradictionMarker, spotCheckRoll } from "../src/merge-verification.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "dotbabel-pr-stack.mjs");
const HEAD = "a".repeat(40);

const BILLING =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. " +
  "Please check the 'Billing & plans' section in your settings";

// A fake `gh`: logs every call (argv and stdin), answers from the first route
// whose regex matches the joined argv, and fails on anything unrouted.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const joined = args.join(" ");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + "\\n");
const routes = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, "utf8"));
for (const r of routes) {
  if (new RegExp(r.match).test(joined)) {
    if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 0);
  }
}
process.stderr.write("fake gh: unrouted: " + joined + "\\n");
process.exit(1);
`;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with an `origin` remote and `.dotbabel.json` on main. */
function makeRepo(config = { attestation: { enforce: true } }) {
  const root = makeTempDir("merge-verification-cli-");
  const repo = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  git(root, "init", "-q", "--bare", bare);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.test");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(path.join(repo, ".dotbabel.json"), JSON.stringify(config));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "chore: config");
  git(repo, "push", "-q", "origin", "main");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  return { root, repo, bin, log: path.join(root, "gh.log"), routesFile: path.join(root, "routes.json") };
}

/** Add a commit on main and push it; returns its SHA. */
function commitOnMain(ctx, subject, files = {}) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ctx.repo, name), text);
  git(ctx.repo, "add", "-A");
  git(ctx.repo, "commit", "-q", "--allow-empty", "-m", subject);
  git(ctx.repo, "push", "-q", "origin", "main");
  return git(ctx.repo, "rev-parse", "HEAD");
}

function runBin(ctx, args, routes, env = {}) {
  fs.writeFileSync(ctx.routesFile, JSON.stringify(routes));
  const base = { ...process.env };
  // A CI runner sets these; a local call must not inherit them.
  for (const k of ["GITHUB_RUN_ID", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GH_REPO", "GH_TOKEN"]) delete base[k];
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ctx.repo,
    encoding: "utf8",
    env: { ...base, PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_LOG: ctx.log, FAKE_GH_ROUTES: ctx.routesFile, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

function ghCalls(ctx) {
  if (!fs.existsSync(ctx.log)) return [];
  return fs
    .readFileSync(ctx.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Routes for `gh pr view` and the paginated files list. */
function prRoutes({ pr = 7, head = HEAD, base, files = ["README.md"] }) {
  return [
    {
      match: `^pr view ${pr} --json headRefOid,baseRefName,baseRefOid,changedFiles$`,
      stdout: { headRefOid: head, baseRefName: "main", baseRefOid: base, changedFiles: files.length },
    },
    { match: `^api repos/\\{owner\\}/\\{repo\\}/pulls/${pr}/files`, stdout: `${files.join("\n")}\n` },
  ];
}

/** Routes for the latest completed default-branch run and its jobs. */
function ciRoutes(runObj, { jobs = [], annotations = {} } = {}) {
  const routes = [
    {
      match: "^api repos/\\{owner\\}/\\{repo\\}/actions/workflows/test\\.yml/runs\\?branch=main&status=completed&per_page=1$",
      stdout: { total_count: runObj ? 1 : 0, workflow_runs: runObj ? [runObj] : [] },
    },
  ];
  if (runObj) routes.push({ match: `^api repos/\\{owner\\}/\\{repo\\}/actions/runs/${runObj.id}/jobs`, stdout: { jobs } });
  for (const [jobId, list] of Object.entries(annotations)) {
    routes.push({ match: `^api repos/\\{owner\\}/\\{repo\\}/check-runs/${jobId}/annotations`, stdout: list });
  }
  return routes;
}

const greenRun = { id: 500, status: "completed", conclusion: "success", head_sha: "f".repeat(40), html_url: "https://example.test/runs/500" };
const billingRun = { id: 501, status: "completed", conclusion: "failure", head_sha: "f".repeat(40), html_url: "https://example.test/runs/501" };
const billingJobs = [{ id: 9001, name: "test", status: "completed", conclusion: "failure", runner_name: "", steps: [] }];
const billingAnnotations = {
  9001: [
    { annotation_level: "failure", message: BILLING },
    { annotation_level: "notice", message: "unrelated notice" },
  ],
};

function readReceipt(ctx, pr) {
  const file = path.join(ctx.repo, ".git", "dotbabel", "receipts", `pr-${pr}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("pr-stack spot-check", () => {
  it("selects a pull request whose changed path matches always_paths and records the decision", () => {
    const ctx = makeRepo({ attestation: { enforce: true, spot_check: { always_paths: ["src/auth/**"] } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--json"], [
      ...prRoutes({ base, files: ["README.md", "src/auth/login.js"] }),
      ...ciRoutes(greenRun),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.decision).toMatchObject({ selected: true, reason: "always_path", matched: "src/auth/login.js" });
    expect(out.ci.state).toBe("available");
    const receipt = readReceipt(ctx, 7);
    expect(receipt.attempts).toEqual([]);
    expect(receipt.spot_checks).toHaveLength(1);
    expect(receipt.spot_checks[0]).toMatchObject({ kind: "spot-check", head_sha: HEAD, selected: true, reason: "always_path", ci: "available" });
  });

  it("verifies every pull request when the latest default-branch run was billing-blocked", () => {
    // An empty spot_check block opts in: rate 0, and rate_when_ci_unavailable defaults to 1.
    const ctx = makeRepo({ attestation: { enforce: true, spot_check: {} } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--json"], [
      ...prRoutes({ base }),
      ...ciRoutes(billingRun, { jobs: billingJobs, annotations: billingAnnotations }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.ci.state).toBe("unavailable");
    expect(out.decision).toMatchObject({ selected: true, reason: "ci_unavailable", rate: 1 });
  });

  it("selects nothing without a spot_check block, even when the default-branch run was billing-blocked", () => {
    const ctx = makeRepo();
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--json"], [
      ...prRoutes({ base }),
      ...ciRoutes(billingRun, { jobs: billingJobs, annotations: billingAnnotations }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.ci.state).toBe("unavailable");
    expect(out.decision).toMatchObject({ selected: false, reason: "off", rate: 0 });
  });

  it("reports CI as unknown, never available, when the Actions API fails", () => {
    const ctx = makeRepo({ attestation: { spot_check: { rate: 0 } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--json"], [
      ...prRoutes({ base }),
      { match: "^api repos/\\{owner\\}/\\{repo\\}/actions/", status: 1, stderr: "API rate limit exceeded" },
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.ci.state).toBe("unknown");
    expect(out.decision).toMatchObject({ selected: false, reason: "off" });
  });

  it("gives the same answer on the same head, from a roll derived from the head", () => {
    const ctx = makeRepo({ attestation: { spot_check: { rate: 0.5 } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const routes = [...prRoutes({ base }), ...ciRoutes(greenRun)];
    const first = runBin(ctx, ["spot-check", "--pr", "7", "--json"], routes).json().result;
    const second = runBin(ctx, ["spot-check", "--pr", "7", "--json"], routes).json().result;
    const roll = spotCheckRoll({ headSha: HEAD, prNumber: 7 });
    expect(first.roll).toBe(roll);
    expect(second.roll).toBe(roll);
    expect(second.decision).toEqual(first.decision);
    expect(first.decision.selected).toBe(roll < 0.5);
    expect(readReceipt(ctx, 7).spot_checks).toHaveLength(2);
  });

  it("reads the policy from the base commit, not the working tree", () => {
    const ctx = makeRepo({ attestation: { spot_check: { rate: 1 } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(ctx.repo, ".dotbabel.json"), JSON.stringify({ attestation: { spot_check: { rate: 0 } } }));
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--json"], [...prRoutes({ base }), ...ciRoutes(greenRun)]);
    expect(r.json().result.decision).toMatchObject({ selected: true, reason: "rate", rate: 1 });
  });

  it("treats an invalid base policy as an env error, not a default", () => {
    const ctx = makeRepo({ attestation: { spot_check: { rate: 2 } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7"], [...prRoutes({ base }), ...ciRoutes(greenRun)]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/spot_check\.rate/);
  });

  it("records an explicit run and shows it next to the decision", () => {
    const ctx = makeRepo({ attestation: { spot_check: { rate: 1 } } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const routes = [...prRoutes({ base }), ...ciRoutes(greenRun)];
    expect(runBin(ctx, ["spot-check", "--pr", "7"], routes).status).toBe(0);
    const rec = runBin(ctx, ["spot-check", "--pr", "7", "--record-explicit", "fail"], routes);
    expect(rec.status, rec.stderr).toBe(0);
    const show = runBin(ctx, ["spot-check", "--pr", "7", "--show", "--json"], []);
    expect(show.status, show.stderr).toBe(0);
    expect(show.json().result.heads).toEqual([{ head_sha: HEAD, selected: true, reason: "rate", rate: 1, explicit: "fail" }]);
    const text = runBin(ctx, ["spot-check", "--pr", "7", "--show"], []);
    expect(text.stdout).toMatch(/selected \(rate\), explicit run: fail/);
  });

  it("refuses an explicit result other than pass or fail", () => {
    const ctx = makeRepo();
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(ctx, ["spot-check", "--pr", "7", "--record-explicit", "maybe"], prRoutes({ base }));
    expect(r.status).toBe(64);
  });
});

describe("pr-stack main-status", () => {
  function mainWithRuns() {
    const ctx = makeRepo();
    const c1 = commitOnMain(ctx, "feat: one (#101)");
    const c2 = commitOnMain(ctx, "feat: two (#102)");
    const c3 = commitOnMain(ctx, "feat: three (#103)");
    const c4 = commitOnMain(ctx, "feat: four (#104)");
    return { ctx, c1, c2, c3, c4 };
  }

  const runsRoute = (runs) => ({
    match: "^api repos/\\{owner\\}/\\{repo\\}/actions/workflows/test\\.yml/runs\\?branch=main&per_page=100$",
    stdout: { total_count: runs.length, workflow_runs: runs },
  });

  it("applies the cumulative rule and reports the debt newer than the last green run", () => {
    const { ctx, c1, c2, c3, c4 } = mainWithRuns();
    const red = { id: 602, status: "completed", conclusion: "failure", head_sha: c3 };
    const r = runBin(ctx, ["main-status", "--limit", "4", "--json"], [
      runsRoute([
        { id: 603, status: "completed", conclusion: "failure", head_sha: c4 },
        red,
        { id: 601, status: "completed", conclusion: "success", head_sha: c2 },
      ]),
      {
        match: "^api repos/\\{owner\\}/\\{repo\\}/actions/runs/603/jobs",
        stdout: { jobs: billingJobs },
      },
      { match: "^api repos/\\{owner\\}/\\{repo\\}/check-runs/9001/annotations", stdout: billingAnnotations[9001] },
      {
        match: "^api repos/\\{owner\\}/\\{repo\\}/actions/runs/602/jobs",
        stdout: { jobs: [{ id: 9002, name: "test", status: "completed", conclusion: "failure", runner_name: "r", steps: [{ number: 1 }] }] },
      },
      { match: "^api repos/\\{owner\\}/\\{repo\\}/check-runs/9002/annotations", stdout: [] },
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.status.lastGreen).toBe(c2);
    expect(out.status.verified).toEqual([c2, c1]);
    expect(out.status.red).toEqual([c3]);
    expect(out.status.unverified).toEqual([c4]);
    expect(out.status.commits.map((c) => c.pr)).toEqual([104, 103, 102, 101]);
    const text = runBin(ctx, ["main-status", "--limit", "4"], [runsRoute([{ id: 601, status: "completed", conclusion: "success", head_sha: c2 }])]);
    expect(text.stdout).toMatch(new RegExp(`last green ${c2.slice(0, 8)}`));
    expect(text.stdout).toMatch(/debt: 2 commit\(s\) newer than the last green run/);
  });

  it("reports unknown, never verified, when the runs cannot be read", () => {
    const { ctx } = mainWithRuns();
    const r = runBin(ctx, ["main-status", "--limit", "4", "--json"], [
      { match: "^api repos/\\{owner\\}/\\{repo\\}/actions/", status: 1, stderr: "API rate limit exceeded" },
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.status.known).toBe(false);
    expect(out.status.verified).toEqual([]);
    expect(out.status.unknown).toHaveLength(4);
    expect(runBin(ctx, ["main-status", "--limit", "4"], [{ match: "^api ", status: 1 }]).stdout).toMatch(/unknown/);
  });

  it("shows each merged pull request's spot-check decision and explicit run", () => {
    const { ctx, c4 } = mainWithRuns();
    const base = git(ctx.repo, "rev-parse", "HEAD~4");
    const pr = [...prRoutes({ pr: 104, base }), ...ciRoutes(greenRun)];
    runBin(ctx, ["spot-check", "--pr", "104"], pr);
    runBin(ctx, ["spot-check", "--pr", "104", "--record-explicit", "pass"], pr);
    const r = runBin(ctx, ["main-status", "--limit", "4", "--json"], [runsRoute([{ id: 601, status: "completed", conclusion: "success", head_sha: c4 }])]);
    expect(r.status, r.stderr).toBe(0);
    const row = r.json().result.status.commits.find((c) => c.pr === 104);
    expect(row.spotCheck).toMatchObject({ selected: expect.any(Boolean), explicit: "pass" });
    expect(r.json().result.status.commits.find((c) => c.pr === 103).spotCheck).toBeNull();
  });

  it("runs the matrix locally in a temporary worktree, labels it weaker than CI, and removes the worktree", () => {
    const ctx = makeRepo();
    commitOnMain(ctx, "chore: matrix (#1)", {
      ".local-attest.config.json": JSON.stringify({ matrix: [{ name: "ok", mode: "hard", command: "node -e \"process.exit(0)\"" }] }),
    });
    const r = runBin(ctx, ["main-status", "--limit", "1", "--local", "--json"], [{ match: "^api ", status: 1 }]);
    expect(r.status, r.stderr).toBe(0);
    const local = r.json().result.local;
    expect(local.result).toBe("pass");
    expect(local.label).toBe("local (same machine as the agent; weaker than CI)");
    expect(fs.existsSync(local.worktree)).toBe(false);
    expect(git(ctx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    // A local pass never verifies a commit.
    expect(r.json().result.status.verified).toEqual([]);
  });

  it("reports a failing local matrix and exits 1", () => {
    const ctx = makeRepo();
    commitOnMain(ctx, "chore: matrix (#1)", {
      ".local-attest.config.json": JSON.stringify({ matrix: [{ name: "bad", mode: "hard", command: "node -e \"process.exit(3)\"" }] }),
    });
    const r = runBin(ctx, ["main-status", "--limit", "1", "--local"], [{ match: "^api ", status: 1 }]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/local \(same machine as the agent; weaker than CI\): fail/);
    expect(git(ctx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("pr-stack contradiction", () => {
  const passingAttestation = renderAttestationHeader(
    buildAttestationPayload({ headSha: HEAD, legs: [{ name: "test", mode: "hard", status: "pass" }], now: new Date(0) }),
  );

  function commentsRoute(bodies) {
    return {
      match: "^api graphql",
      stdout: {
        data: {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: bodies.map((body) => ({ body, authorAssociation: "OWNER", lastEditedAt: null, author: { login: "owner" } })),
              },
            },
          },
        },
      },
    };
  }

  /** A merged pull request #7 whose merge commit is the tip of main. */
  function merged() {
    const ctx = makeRepo({ attestation: { enforce: true, trusted_associations: ["OWNER"] } });
    const sha = commitOnMain(ctx, "feat: thing (#7)");
    return { ctx, sha };
  }

  function routes(sha, { jobs, annotations = [], comments = [passingAttestation], issues = [] }) {
    return [
      { match: "^api repos/\\{owner\\}/\\{repo\\}/actions/runs/555$", stdout: { id: 555, status: "in_progress", conclusion: null, head_sha: sha } },
      { match: "^api repos/\\{owner\\}/\\{repo\\}/actions/runs/555/jobs", stdout: { jobs } },
      { match: "^api repos/\\{owner\\}/\\{repo\\}/check-runs/\\d+/annotations", stdout: annotations },
      { match: `^api repos/\\{owner\\}/\\{repo\\}/commits/${sha}/pulls$`, stdout: [{ number: 7, merge_commit_sha: sha, head: { sha: HEAD } }] },
      commentsRoute(comments),
      { match: "^api repos/\\{owner\\}/\\{repo\\}/labels/attestation-contradicted$", status: 1, stderr: "HTTP 404" },
      { match: "^api --method POST repos/\\{owner\\}/\\{repo\\}/labels --input -$", stdout: {} },
      { match: "^api --method POST repos/\\{owner\\}/\\{repo\\}/issues/7/labels --input -$", stdout: [] },
      { match: "^issue list --label attestation-contradicted --state all", stdout: issues },
      { match: "^api --method POST repos/\\{owner\\}/\\{repo\\}/issues --input -$", stdout: { number: 99, html_url: "https://example.test/issues/99" } },
    ];
  }

  const realFailure = [{ id: 9101, name: "test", status: "completed", conclusion: "failure", runner_name: "r", steps: [{ number: 1 }, { number: 2 }] }];
  const ciEnv = { GITHUB_RUN_ID: "555", GITHUB_SERVER_URL: "https://github.example", GITHUB_REPOSITORY: "o/r" };

  it("labels the pull request and opens one issue when a real failure contradicts a passing attestation", () => {
    const { ctx, sha } = merged();
    const r = runBin(ctx, ["contradiction", "--sha", sha, "--test-result", "failure", "--post", "--json"], routes(sha, { jobs: realFailure }), ciEnv);
    expect(r.status, r.stderr).toBe(1);
    const out = r.json().result;
    expect(out.contradiction).toBe(true);
    expect(out.pr).toBe(7);
    expect(out.attestedSha).toBe(HEAD);
    const calls = ghCalls(ctx);
    const issuePost = calls.find((c) => c.args.join(" ") === "api --method POST repos/{owner}/{repo}/issues --input -");
    expect(issuePost).toBeDefined();
    const body = JSON.parse(issuePost.stdin);
    expect(body.labels).toEqual(["attestation-contradicted"]);
    expect(body.body).toContain(contradictionMarker({ pr: 7, sha: HEAD }));
    expect(body.body).toContain("https://github.example/o/r/actions/runs/555");
    expect(body.body).toContain(sha);
    const labelPost = calls.find((c) => c.args.join(" ") === "api --method POST repos/{owner}/{repo}/issues/7/labels --input -");
    expect(JSON.parse(labelPost.stdin)).toEqual({ labels: ["attestation-contradicted"] });
    expect(calls.some((c) => c.args.join(" ") === "api --method POST repos/{owner}/{repo}/labels --input -")).toBe(true);
  });

  it("does not open a second issue when one already carries the marker", () => {
    const { ctx, sha } = merged();
    const issues = [{ number: 12, body: `old\n${contradictionMarker({ pr: 7, sha: HEAD })}\n` }];
    const r = runBin(ctx, ["contradiction", "--sha", sha, "--test-result", "failure", "--post", "--json"], routes(sha, { jobs: realFailure, issues }), ciEnv);
    expect(r.status, r.stderr).toBe(1);
    expect(r.json().result.issue).toMatchObject({ number: 12, created: false });
    expect(ghCalls(ctx).some((c) => c.args.join(" ") === "api --method POST repos/{owner}/{repo}/issues --input -")).toBe(false);
  });

  it("never treats a billing-blocked run as a contradiction", () => {
    const { ctx, sha } = merged();
    const jobs = [{ id: 9001, name: "test", status: "completed", conclusion: "failure", runner_name: "", steps: [] }];
    const r = runBin(
      ctx,
      ["contradiction", "--sha", sha, "--test-result", "failure", "--post", "--json"],
      routes(sha, { jobs, annotations: billingAnnotations[9001] }),
      ciEnv,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.json().result).toMatchObject({ contradiction: false, run: "unverified" });
    expect(ghCalls(ctx).some((c) => c.args.includes("POST"))).toBe(false);
  });

  it("is not a contradiction when the pull request had no passing attestation", () => {
    const { ctx, sha } = merged();
    const r = runBin(ctx, ["contradiction", "--sha", sha, "--test-result", "failure", "--post", "--json"], routes(sha, { jobs: realFailure, comments: [] }), ciEnv);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json().result.contradiction).toBe(false);
    expect(ghCalls(ctx).some((c) => c.args.includes("POST"))).toBe(false);
  });

  it("is not a contradiction when the test job did not fail", () => {
    const { ctx, sha } = merged();
    const r = runBin(ctx, ["contradiction", "--sha", sha, "--test-result", "cancelled", "--json"], [], ciEnv);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json().result.contradiction).toBe(false);
  });

  it("is an env error when the run cannot be read, never a silent no", () => {
    const { ctx, sha } = merged();
    const r = runBin(ctx, ["contradiction", "--sha", sha, "--test-result", "failure"], [{ match: "^api ", status: 1, stderr: "rate limit" }], ciEnv);
    expect(r.status).toBe(2);
  });

  it("refuses a --sha that is not a full SHA", () => {
    const { ctx } = merged();
    const r = runBin(ctx, ["contradiction", "--sha", "HEAD;rm", "--test-result", "failure"], []);
    expect(r.status).toBe(64);
  });

  it("labels a pull request whose local explicit run failed against a passing attestation", () => {
    const ctx = makeRepo({ attestation: { enforce: true } });
    const base = git(ctx.repo, "rev-parse", "HEAD");
    const r = runBin(
      ctx,
      ["contradiction", "--pr", "7", "--local-failure", "--post", "--json"],
      [
        { match: "^pr view 7 --json headRefOid,baseRefOid$", stdout: { headRefOid: HEAD, baseRefOid: base } },
        ...routes(base, { jobs: [] }).slice(4),
      ],
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.json().result).toMatchObject({ contradiction: true, pr: 7, attestedSha: HEAD, local: true });
    const issuePost = ghCalls(ctx).find((c) => c.args.join(" ") === "api --method POST repos/{owner}/{repo}/issues --input -");
    expect(JSON.parse(issuePost.stdin).body).toMatch(/same machine as the agent/);
  });
});

describe("pr-stack help", () => {
  it("lists the three merge-verification subcommands", () => {
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    for (const sub of ["spot-check", "main-status", "contradiction"]) expect(r.stdout).toMatch(new RegExp(`^  ${esc(sub)} `, "m"));
  });
});
