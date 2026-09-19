import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { attestRunPath, createRunManifest, recordLeg, sha256File, writeRunManifest } from "../src/attest-run.mjs";
import { ERROR_CODES, ValidationError } from "../src/lib/errors.mjs";
import { buildReuseResolver, validateReuse } from "../src/quality/reuse.mjs";
import { QUALITY_CAPABILITIES } from "../src/quality/types.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();

/** A committed, clean repository — or a bare directory when `withGit` is false. */
function repo({ withGit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-reuse-resolver-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".dotbabel/\ncoverage/\npkg/web/coverage/\n");
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  if (withGit) {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
  }
  return root;
}

const now = new Date("2026-01-01T00:00:00Z");
/** Record a passed `test` leg producing `reportRel` (written into the repo) at `head`. */
function attest(root, { head = git(root, "rev-parse", "HEAD"), reportRel = "coverage/lcov.info", status = "pass" } = {}) {
  const abs = path.join(root, reportRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "SF:a\nend_of_record\n");
  let m = createRunManifest({ headSha: head, now });
  m = recordLeg(m, { name: "test", mode: "hard", status, produces: [{ path: reportRel, sha256: sha256File(abs) }], now });
  m = recordLeg(m, { name: "lint", mode: "hard", status: "pass", now });
  writeRunManifest(root, m);
  return head;
}

const plan = (over = {}) => ({
  id: "p", componentId: ".:javascript", capability: "coverage",
  report: { format: "lcov", path: "coverage/lcov.info" }, ...over,
});

describe("validateReuse", () => {
  it("returns a well-formed request unchanged", () => {
    const req = { lint: "lint", coverage: "test" };
    expect(validateReuse(req)).toBe(req);
  });

  it.each([
    ["null", null],
    ["an array", ["lint=lint"]],
    ["a string", "lint=lint"],
    ["a number", 3],
  ])("rejects %s as a request", (_label, value) => {
    expect(() => validateReuse(value)).toThrow(/reuse must map a capability to a leg name/);
  });

  it("throws a quality ValidationError carrying the config-invalid code", () => {
    try {
      validateReuse(null);
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.QUALITY_CONFIG_INVALID);
      expect(err.category).toBe("quality");
    }
  });

  it("names the offending capability and lists the valid ones", () => {
    try {
      validateReuse({ linting: "lint" });
      throw new Error("did not throw");
    } catch (err) {
      expect(err.message).toContain('"linting"');
      expect(err.hint).toBe(`capabilities: ${QUALITY_CAPABILITIES.join(", ")}`);
      expect(err.category).toBe("quality");
    }
  });

  it.each([
    ["an empty leg", ""],
    ["a whitespace-only leg", "   "],
    ["a numeric leg", 7],
    ["a null leg", null],
  ])("rejects %s and names the capability", (_label, leg) => {
    try {
      validateReuse({ lint: leg });
      throw new Error("did not throw");
    } catch (err) {
      expect(err.message).toBe("reuse for lint needs a non-empty leg name");
      expect(err.code).toBe(ERROR_CODES.QUALITY_CONFIG_INVALID);
      expect(err.category).toBe("quality");
    }
  });

  it("accepts a leg name with surrounding text, because only emptiness is invalid", () => {
    expect(() => validateReuse({ lint: " lint " })).not.toThrow();
  });
});

describe("buildReuseResolver", () => {
  it("resolves a plan whose capability was requested and records the decision", () => {
    const root = repo();
    const head = attest(root);
    const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
    expect(r.resolve(plan())).toEqual({ leg: "test", head_sha: head });
    expect(r.decisions).toEqual([{ capability: "coverage", leg: "test", reused: true }]);
  });

  it("returns null and records nothing for a capability nobody asked to reuse", () => {
    const root = repo();
    attest(root);
    const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
    expect(r.resolve(plan({ capability: "lint" }))).toBeNull();
    expect(r.decisions).toEqual([]);
  });

  it("records a refusal with its capability, leg and reason", () => {
    const root = repo();
    const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
    expect(r.resolve(plan())).toBeNull();
    expect(r.decisions).toEqual([{ capability: "coverage", leg: "test", reused: false, reason: "NO_MANIFEST" }]);
  });

  it("validates the request before doing anything else", () => {
    expect(() => buildReuseResolver({ repoRoot: repo(), reuse: { nonsense: "x" } })).toThrow(/capability/);
  });

  describe("which report a plan is checked against", () => {
    it("joins a nested component root onto the report path", () => {
      const root = repo();
      attest(root, { reportRel: "pkg/web/coverage/lcov.info" });
      const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
      expect(r.resolve(plan({ componentId: "pkg/web:javascript" }))).not.toBeNull();
    });

    it("refuses when the leg produced the report at a different component path", () => {
      // Same file name, wrong place. The path is part of the identity.
      const root = repo();
      attest(root, { reportRel: "coverage/lcov.info" });
      const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
      expect(r.resolve(plan({ componentId: "pkg/web:javascript" }))).toBeNull();
      expect(r.decisions[0].reason).toBe("REPORT_NOT_PRODUCED");
    });

    it.each([
      ["an exit-code tool", { format: "exit-code" }],
      ["a plan with no report at all", undefined],
      ["a report with no path", { format: "lcov" }],
      ["a report whose path is not a string", { format: "lcov", path: 5 }],
    ])("needs no produced file for %s", (_label, report) => {
      const root = repo();
      attest(root);
      const r = buildReuseResolver({ repoRoot: root, reuse: { lint: "lint" } });
      expect(r.resolve(plan({ capability: "lint", report }))).not.toBeNull();
    });
  });

  describe("facts are read once, when the resolver is built", () => {
    it("keeps answering from the manifest it read even if the file changes afterwards", () => {
      // A tool that ran earlier in the same check must not be able to change
      // the answer for a later one by rewriting the manifest under it.
      const root = repo();
      attest(root);
      const r = buildReuseResolver({ repoRoot: root, reuse: { lint: "lint" } });
      fs.rmSync(attestRunPath(root));
      expect(r.resolve(plan({ capability: "lint", report: undefined }))).not.toBeNull();
    });

    it("keeps the head it read even if a commit lands afterwards", () => {
      const root = repo();
      const head = attest(root);
      const r = buildReuseResolver({ repoRoot: root, reuse: { lint: "lint" } });
      fs.writeFileSync(path.join(root, "b.txt"), "b");
      git(root, "add", ".");
      git(root, "commit", "-qm", "later");
      expect(r.resolve(plan({ capability: "lint", report: undefined })).head_sha).toBe(head);
    });

    it("keeps the tree state it read even if the tree becomes dirty afterwards", () => {
      const root = repo();
      attest(root);
      const r = buildReuseResolver({ repoRoot: root, reuse: { lint: "lint" } });
      fs.writeFileSync(path.join(root, "a.txt"), "dirtied after the resolver was built");
      expect(r.resolve(plan({ capability: "lint", report: undefined }))).not.toBeNull();
    });
  });

  describe("when git cannot answer", () => {
    it("treats a directory that is not a repository as a mismatch, never as a match", () => {
      const root = repo({ withGit: false });
      const m = createRunManifest({ headSha: "a".repeat(40), now });
      writeRunManifest(root, recordLeg(m, { name: "lint", mode: "hard", status: "pass", now }));
      const r = buildReuseResolver({ repoRoot: root, reuse: { lint: "lint" } });
      expect(r.resolve(plan({ capability: "lint", report: undefined }))).toBeNull();
      expect(r.decisions[0].reused).toBe(false);
      expect(r.decisions[0].reason).toBe("HEAD_MISMATCH");
    });
  });

  it("ignores gitignored output when judging whether the tree is clean", () => {
    // The manifest and coverage output are both gitignored. If they counted,
    // every run would look dirty by the time it reached the reader.
    const root = repo();
    attest(root);
    expect(git(root, "status", "--porcelain")).toBe("");
    const r = buildReuseResolver({ repoRoot: root, reuse: { coverage: "test" } });
    expect(r.resolve(plan())).not.toBeNull();
  });
});
