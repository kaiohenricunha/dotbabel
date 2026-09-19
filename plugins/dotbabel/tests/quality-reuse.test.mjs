import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { createRunManifest, recordLeg, sha256File, writeRunManifest } from "../src/attest-run.mjs";
import { runQualityCheck } from "../src/quality/index.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/dotbabel-quality.mjs");
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const LCOV = "SF:index.js\nDA:1,1\nDA:2,1\nend_of_record\n";
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

/**
 * A committed two-commit repository whose tools each leave a marker file, so a
 * test can prove a tool did or did not run rather than infer it. The tree is
 * CLEAN, which reuse requires and which is also how local-attest sees it.
 */
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-reuse-"));
  dirs.push(root);
  const marker = (name) => `require("node:fs").writeFileSync(${JSON.stringify(name)}, "x")`;
  fs.writeFileSync(path.join(root, ".gitignore"), ".dotbabel/\nran-*\ncoverage/\n");
  fs.writeFileSync(
    path.join(root, ".dotbabel.json"),
    JSON.stringify({
      quality: {
        base_ref: "main",
        components: [
          {
            root: ".",
            languages: ["javascript"],
            tools: {
              lint: { argv: ["node", "-e", marker("ran-lint")] },
              test: { argv: ["node", "-e", marker("ran-test")] },
              coverage: {
                argv: ["node", "-e", `${marker("ran-coverage")};require("node:fs").mkdirSync("coverage",{recursive:true});require("node:fs").writeFileSync("coverage/lcov.info", ${JSON.stringify(LCOV)})`],
                report: { format: "lcov", path: "coverage/lcov.info" },
              },
            },
          },
        ],
      },
    }),
  );
  fs.writeFileSync(path.join(root, "index.js"), "const first = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  fs.appendFileSync(path.join(root, "index.js"), "const second = 2;\n");
  git(root, "commit", "-qam", "change");
  return root;
}

/** The lcov a passed `test` leg would have left behind, plus a manifest saying so. */
function attest(root, { head = git(root, "rev-parse", "HEAD"), legs = { lint: "pass", test: "pass" }, report = LCOV } = {}) {
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(root, "coverage/lcov.info"), report);
  const now = new Date("2026-01-01T00:00:00Z");
  let m = createRunManifest({ headSha: head, now });
  for (const [name, status] of Object.entries(legs)) {
    const produces = name === "test" ? [{ path: "coverage/lcov.info", sha256: sha256File(path.join(root, "coverage/lcov.info")) }] : [];
    m = recordLeg(m, { name, mode: "hard", status, produces, now });
  }
  writeRunManifest(root, m);
  return m;
}

const REUSE = { lint: "lint", test: "test", coverage: "test" };
const run = (root, over = {}) =>
  runQualityCheck({ repoRoot: root, base: "HEAD~1", profile: "pr", allowProjectCommands: true, reuse: REUSE, ...over });
const ran = (root, tool) => fs.existsSync(path.join(root, `ran-${tool}`));

describe("quality check reusing a local-attest run", () => {
  it("runs no tool the matrix already ran at this exact commit", async () => {
    const root = repository();
    attest(root);
    await run(root);
    expect(ran(root, "lint")).toBe(false);
    expect(ran(root, "test")).toBe(false);
    expect(ran(root, "coverage")).toBe(false);
  });

  it("still evaluates the coverage rules, from the report the leg wrote", async () => {
    // The point of reusing the report rather than skipping the rule: the
    // changed-line coverage verdict must come from real data.
    const root = repository();
    attest(root);
    const result = await run(root);
    const rule = result.results.find((r) => r.rule === "coverage.changed_lines");
    expect(rule).toBeDefined();
    expect(rule.state).toBe("checked");
    expect(rule.verdict).toBe("pass");
  });

  it("marks every reused execution with the leg and commit it came from", async () => {
    const root = repository();
    const head = git(root, "rev-parse", "HEAD");
    attest(root);
    const result = await run(root);
    for (const capability of ["lint", "test", "coverage"]) {
      const e = result.executions.find((x) => x.capability === capability);
      expect(e.reused).toEqual({ leg: REUSE[capability], head_sha: head });
    }
  });

  it("reports each decision, so a caller can see what was and was not reused", async () => {
    const root = repository();
    attest(root);
    const result = await run(root);
    expect(result.reuse.map((d) => [d.capability, d.leg, d.reused]).sort()).toEqual([
      ["coverage", "test", true],
      ["lint", "lint", true],
      ["test", "test", true],
    ]);
  });

  it("says in the rule message that the result was reused, not that a tool ran here", async () => {
    const root = repository();
    attest(root);
    const result = await run(root);
    const lint = result.results.find((r) => r.rule === "correctness.lint");
    expect(lint.message).toMatch(/reused from local-attest leg "lint"/);
  });

  describe("declines, and runs the tool itself, whenever it cannot prove the result is about this tree", () => {
    it("for a manifest that belongs to a different commit", async () => {
      const root = repository();
      attest(root, { head: "b".repeat(40) });
      const result = await run(root);
      expect(ran(root, "lint") && ran(root, "test") && ran(root, "coverage")).toBe(true);
      expect(result.executions.every((e) => e.reused === undefined)).toBe(true);
      expect(new Set(result.reuse.map((d) => d.reason))).toEqual(new Set(["HEAD_MISMATCH"]));
    });

    it("for a dirty working tree", async () => {
      const root = repository();
      attest(root);
      fs.appendFileSync(path.join(root, "index.js"), "const uncommitted = 3;\n");
      const result = await run(root);
      expect(ran(root, "lint")).toBe(true);
      expect(new Set(result.reuse.map((d) => d.reason))).toEqual(new Set(["DIRTY_TREE"]));
    });

    it("for a leg that did not pass", async () => {
      const root = repository();
      attest(root, { legs: { lint: "fail", test: "pass" } });
      const result = await run(root);
      expect(ran(root, "lint")).toBe(true);
      expect(result.reuse.find((d) => d.capability === "lint").reason).toBe("LEG_NOT_PASSED");
    });

    it("for a leg the manifest never recorded", async () => {
      const root = repository();
      attest(root, { legs: { test: "pass" } });
      await run(root);
      expect(ran(root, "lint")).toBe(true);
      expect(ran(root, "test")).toBe(false);
    });

    it("for no manifest at all", async () => {
      const root = repository();
      const result = await run(root);
      expect(ran(root, "lint") && ran(root, "test") && ran(root, "coverage")).toBe(true);
      expect(new Set(result.reuse.map((d) => d.reason))).toEqual(new Set(["NO_MANIFEST"]));
    });
  });

  it("decides per capability: a tampered report costs coverage its reuse but not lint", async () => {
    // The staleness this design exists to rule out — a file at the right path
    // that is not the file the leg wrote. It must invalidate exactly the
    // capability that reads that file, and no more.
    const root = repository();
    attest(root);
    fs.writeFileSync(path.join(root, "coverage/lcov.info"), "SF:index.js\nDA:1,0\nend_of_record\n");
    const result = await run(root);
    expect(ran(root, "lint")).toBe(false);
    expect(ran(root, "coverage")).toBe(true);
    expect(result.reuse.find((d) => d.capability === "coverage").reason).toBe("REPORT_CHANGED");
    expect(result.reuse.find((d) => d.capability === "lint").reused).toBe(true);
  });

  it("uses freshly generated coverage, not the tampered file, after declining", async () => {
    const root = repository();
    attest(root);
    fs.writeFileSync(path.join(root, "coverage/lcov.info"), "SF:index.js\nDA:1,0\nDA:2,0\nend_of_record\n");
    const result = await run(root);
    // The coverage tool rewrote the file with full coverage, so the rule passes;
    // parsing the tampered zeros instead would have failed it.
    expect(result.results.find((r) => r.rule === "coverage.changed_lines").verdict).toBe("pass");
  });

  it("changes nothing when no reuse is requested", async () => {
    const root = repository();
    attest(root);
    const result = await run(root, { reuse: undefined });
    expect(ran(root, "lint") && ran(root, "test") && ran(root, "coverage")).toBe(true);
    expect(result.reuse).toBeUndefined();
  });

  it("needs no project-command trust when everything was reused", async () => {
    const root = repository();
    attest(root);
    const env = { ...process.env, CHECK_ON_STOP_TRUSTED_FILE: path.join(root, "no-such-allowlist") };
    await expect(run(root, { allowProjectCommands: false, env })).resolves.toBeDefined();
  });

  it("rejects a capability the policy does not know", async () => {
    const root = repository();
    attest(root);
    await expect(run(root, { reuse: { linting: "lint" } })).rejects.toThrow(/capability/);
  });

  it("rejects an empty leg name rather than matching nothing silently", async () => {
    const root = repository();
    attest(root);
    await expect(run(root, { reuse: { lint: "" } })).rejects.toThrow(/leg/);
  });
});

describe("dotbabel quality check --reuse (CLI)", () => {
  const cli = (root, ...args) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const check = ["check", "--profile", "pr", "--base", "HEAD~1", "--allow-project-commands", "--json"];

  it("reuses what the matrix ran, end to end, and reports it", () => {
    const root = repository();
    attest(root);
    const r = cli(root, ...check, "--reuse", "lint=lint", "--reuse", "test=test", "--reuse", "coverage=test");
    expect(r.status).toBe(0);
    expect(ran(root, "lint") || ran(root, "test") || ran(root, "coverage")).toBe(false);
    const out = JSON.parse(r.stdout);
    expect(out.reuse.every((d) => d.reused)).toBe(true);
  });

  it("runs the tools itself when there is nothing to reuse, and says why", () => {
    const root = repository();
    const r = cli(root, ...check, "--reuse", "lint=lint");
    expect(r.status).toBe(0);
    expect(ran(root, "lint")).toBe(true);
    expect(JSON.parse(r.stdout).reuse).toEqual([{ capability: "lint", leg: "lint", reused: false, reason: "NO_MANIFEST" }]);
  });

  it.each([
    ["an entry with no leg", ["--reuse", "lint"]],
    ["an empty leg", ["--reuse", "lint="]],
    ["an empty capability", ["--reuse", "=lint"]],
    ["an unknown capability", ["--reuse", "linting=lint"]],
  ])("rejects %s as a usage error", (_label, flags) => {
    const root = repository();
    const r = cli(root, ...check, ...flags);
    expect(r.status).toBe(64);
    expect(ran(root, "lint")).toBe(false);
  });

  it("rejects --reuse on a command that runs nothing", () => {
    // `detect` executes no tool, so a reuse request there is a misunderstanding
    // worth surfacing, not something to ignore.
    const root = repository();
    const r = cli(root, "detect", "--reuse", "lint=lint");
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/--reuse/);
  });

  it("names the flag in the help text", () => {
    expect(cli(repository(), "--help").stdout).toContain("--reuse");
  });
});

describe("the schemas describe what reuse actually emits", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const schema = (name) => JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8"));

  it("validates a real reusing check result against the result schema", async () => {
    // Not a hand-written fixture: the envelope a real reusing run produced, so
    // the schema and the emitter cannot drift apart unnoticed.
    const repo = repository();
    attest(repo);
    const result = await run(repo);
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema("dotbabel.quality-result.schema.json"));
    const ok = validate(JSON.parse(JSON.stringify(result)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("validates a real declined-reuse result, reason included", async () => {
    const repo = repository();
    const result = await run(repo);
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.quality-result.schema.json"));
    expect(validate(JSON.parse(JSON.stringify(result)))).toBe(true);
    expect(result.reuse[0].reason).toBe("NO_MANIFEST");
  });

  it("rejects a reason the schema does not name", () => {
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.quality-result.schema.json"));
    const base = { schema_version: 1, command: "check", state: "checked", profile: "pr", verdict: "pass", results: [] };
    expect(validate({ ...base, reuse: [{ capability: "lint", leg: "lint", reused: false, reason: "BECAUSE" }] })).toBe(false);
  });

  it("validates the manifest a real matrix run writes", () => {
    const repo = repository();
    const manifest = attest(repo);
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.attest-run.schema.json"));
    expect(validate(manifest)).toBe(true);
  });

  it("rejects a manifest with an unknown key, a bad status, or a malformed digest", () => {
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.attest-run.schema.json"));
    const ok = { schema_version: 1, head_sha: "a".repeat(40), started_at: "2026-01-01T00:00:00Z", legs: {} };
    expect(validate(ok)).toBe(true);
    expect(validate({ ...ok, extra: 1 })).toBe(false);
    expect(validate({ ...ok, legs: { t: { mode: "hard", status: "great", finished_at: "2026-01-01T00:00:00Z", produces: [] } } })).toBe(false);
    expect(validate({ ...ok, legs: { t: { mode: "hard", status: "pass", finished_at: "2026-01-01T00:00:00Z", produces: [{ path: "x", sha256: "abc" }] } } })).toBe(false);
  });
});
