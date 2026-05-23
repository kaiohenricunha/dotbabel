/**
 * Synthetic end-to-end smoke test.
 *
 * Drives `execute()` with a fully stubbed `deps` object whose `run` recorder
 * returns the responses the real gh/git would for a clean run. The config
 * mirrors a squadranks-shaped matrix (Node + Go monorepo) so the snapshot
 * doubles as an equivalence check — it should produce a comment body the
 * squadranks CI gate would accept verbatim.
 *
 * No subprocess executes; no file is written; no network call is made. The
 * recorder asserts at the end that nothing escaped the stubs.
 */
import { describe, it, expect } from "vitest";

import { validateConfig } from "../src/local-attest-config.mjs";
import { execute } from "../src/local-attest-runner.mjs";
import { buildAttestMarker } from "../src/local-attest-lib.mjs";

const HEAD = "abc1234abc1234abc1234abc1234abc1234abc12";

function squadranksShapedConfig() {
  return validateConfig({
    matrix: [
      { name: "npm ci", mode: "hard", command: "true" },
      { name: "actionlint", mode: "hard", command: "true" },
      { name: "eslint", mode: "hard", command: "true" },
      { name: "prettier", mode: "hard", command: "true" },
      { name: "knip", mode: "advisory", command: "true" },
      { name: "npm audit (prod, high+)", mode: "hard", command: "true" },
      { name: "verify:repo:harness", mode: "hard", command: "true" },
      { name: "ranking sanity", mode: "hard", command: "true" },
      { name: "frontend unit tests", mode: "hard", command: "true" },
      { name: "build", mode: "hard", command: "true" },
      { name: "bundle size (<=500KB gz)", mode: "hard", command: "true" },
      { name: "e2e (playwright)", mode: "hard", command: "true" },
      { name: "backend tests + coverage", mode: "hard", command: "true", cwd: "api" },
      { name: "backend integration", mode: "hard", command: "true", cwd: "api" },
      { name: "govulncheck", mode: "hard", command: "true", cwd: "api" },
      { name: "golangci-lint", mode: "advisory", command: "true", cwd: "api" },
    ],
    requireDocker: false,
    pushAfterAttest: false,
  });
}

function happyDeps() {
  const calls = { run: [], gh: [], appendLog: [], log: [], warn: [] };
  const REPLIES = [
    [/git rev-parse --abbrev-ref HEAD/, { stdout: "feature\n" }],
    [/git status --porcelain/, { stdout: "" }],
    [/gh auth status/, { status: 0 }],
    [/gh repo view --json nameWithOwner/, { stdout: "kaio/squadranks\n" }],
    [/gh pr view --json number/, { stdout: "42\n" }],
    [/git rev-parse HEAD/, { stdout: `${HEAD}\n` }],
    [/gh pr view 42 --json headRefOid/, { stdout: `${HEAD}\n` }],
    [/gh api user --jq \.login/, { stdout: "kaio\n" }],
    [/gh api repos\/.*\/collaborators\/.*\/permission/, { stdout: "ADMIN\n" }],
    [/git push/, { status: 0 }],
    [/gh api repos.*\/comments/, { stdout: "[]" }],
  ];
  const run = (cmd, opts = {}) => {
    calls.run.push({ cmd, opts });
    for (const [pat, result] of REPLIES) {
      if (pat.test(cmd)) return { status: 0, stdout: "", stderr: "", ...result };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    deps: {
      run,
      ghApiWithInput(cmd, payload) {
        calls.gh.push({ cmd, payload });
        return "";
      },
      appendLog(path, line) {
        calls.appendLog.push({ path, line });
      },
      hostname() {
        return "ci-stub";
      },
      log(msg) {
        calls.log.push(msg);
      },
      warn(msg) {
        calls.warn.push(msg);
      },
    },
  };
}

describe("local-attest end-to-end smoke (synthetic, no real I/O)", () => {
  it("marker invariant: rendered comment line 1 is exactly the marker", () => {
    const { deps } = happyDeps();
    const r = execute(deps, squadranksShapedConfig(), {
      prOverride: null,
      push: false,
      dryRun: true,
    });
    const firstLine = r.body.split("\n")[0];
    expect(firstLine).toBe(buildAttestMarker(HEAD));
    expect(firstLine).toMatch(/^<!-- local-attest verified-sha=[0-9a-f]{7,40} -->$/);
  });

  it("table fidelity: every leg appears once, in order, with correct mode + status", () => {
    const { deps } = happyDeps();
    const r = execute(deps, squadranksShapedConfig(), {
      prOverride: null,
      push: false,
      dryRun: true,
    });
    const expected = squadranksShapedConfig().matrix;
    const rows = r.body.split("\n").filter((l) => /^\| .+ \| (hard|advisory) \| /.test(l));
    expect(rows).toHaveLength(expected.length);
    expected.forEach((leg, i) => {
      expect(rows[i]).toContain(`| ${leg.name} | ${leg.mode} | pass |`);
    });
  });

  it("I/O containment: dry-run never POSTs/PATCHes, never pushes, never writes audit log", () => {
    const { deps, calls } = happyDeps();
    execute(deps, squadranksShapedConfig(), { prOverride: null, push: true, dryRun: true });
    expect(calls.gh).toHaveLength(0);
    expect(calls.appendLog).toHaveLength(0);
    expect(calls.run.some((c) => /git push/.test(c.cmd))).toBe(false);
    expect(calls.run.some((c) => /gh label create/.test(c.cmd))).toBe(false);
    expect(calls.run.some((c) => /gh pr edit/.test(c.cmd))).toBe(false);
  });

  it("snapshot: rendered comment body (timestamp redacted) is stable", () => {
    const { deps } = happyDeps();
    const r = execute(deps, squadranksShapedConfig(), {
      prOverride: null,
      push: false,
      dryRun: true,
    });
    const redacted = r.body.replace(/`\d{4}-\d{2}-\d{2}T[^`]+`/g, "`<TS>`");
    expect(redacted).toMatchInlineSnapshot(`
      "<!-- local-attest verified-sha=abc1234abc1234abc1234abc1234abc1234abc12 -->
      ## Local Attestation

      The full CI check matrix ran locally and the hard legs passed for \`abc1234a\`.
      Test and Preview will skip for this commit. A new push re-runs CI automatically.

      | Check | Mode | Result | Duration |
      |---|---|---|---|
      | npm ci | hard | pass | 0s |
      | actionlint | hard | pass | 0s |
      | eslint | hard | pass | 0s |
      | prettier | hard | pass | 0s |
      | knip | advisory | pass | 0s |
      | npm audit (prod, high+) | hard | pass | 0s |
      | verify:repo:harness | hard | pass | 0s |
      | ranking sanity | hard | pass | 0s |
      | frontend unit tests | hard | pass | 0s |
      | build | hard | pass | 0s |
      | bundle size (<=500KB gz) | hard | pass | 0s |
      | e2e (playwright) | hard | pass | 0s |
      | backend tests + coverage | hard | pass | 0s |
      | backend integration | hard | pass | 0s |
      | govulncheck | hard | pass | 0s |
      | golangci-lint | advisory | pass | 0s |

      - Host: \`ci-stub\`
      - Attested at: \`<TS>\`
      - Verified SHA: \`abc1234abc1234abc1234abc1234abc1234abc12\`"
    `);
  });

  it("squadranks-shape compatibility: marker, default label, and audit shape match the gate's expectations", () => {
    // Full run (not dry-run) so upsert + label + audit fire.
    const { deps, calls } = happyDeps();
    execute(deps, squadranksShapedConfig(), { prOverride: null, push: false, dryRun: false });

    // 1) Comment posted via stdin payload, body line 1 is the marker.
    expect(calls.gh).toHaveLength(1);
    const payloadBody = calls.gh[0].payload.body;
    expect(payloadBody.split("\n")[0]).toBe(buildAttestMarker(HEAD));

    // 2) Label is the documented default the gate's audit query relies on.
    const labelCreate = calls.run.find((c) => /gh label create/.test(c.cmd));
    expect(labelCreate.cmd).toContain("ci/local-verified");

    // 3) Audit log line shape matches the documented JSONL schema.
    expect(calls.appendLog).toHaveLength(1);
    const audit = JSON.parse(calls.appendLog[0].line);
    expect(audit).toMatchObject({
      pr: 42,
      sha: HEAD,
      host: "ci-stub",
      advisoryFails: [],
    });
    expect(typeof audit.ts).toBe("string");
  });
});
