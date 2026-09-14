import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUntrustedArgvChange } from "../src/criteria/trust-check.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-check-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function writeSpec(dir, criteria) {
  const specDir = path.join(dir, "docs", "specs", "example");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify({ id: "example", acceptance_criteria: criteria }));
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A capture() that runs real git, and answers `gh api` calls from a fake table. */
function deps(dir, gh = {}) {
  return {
    capture(cmd) {
      if (cmd.startsWith("gh api")) {
        for (const [pattern, value] of Object.entries(gh)) {
          if (new RegExp(pattern).test(cmd)) return value;
        }
        throw new Error(`no fake gh response for: ${cmd}`);
      }
      return execFileSync(cmd, { cwd: dir, encoding: "utf8", shell: true }).trim();
    },
  };
}

describe("findUntrustedArgvChange", () => {
  it("returns null when spec.json was never touched between base and head", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "x");
    const head = commit(dir, "unrelated change");
    const result = findUntrustedArgvChange(deps(dir), { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] });
    expect(result).toBeNull();
  });

  it("returns null when only a planned criterion's argv changed", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "planned", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "planned", argv: ["b"] }]);
    const head = commit(dir, "change planned argv");
    const result = findUntrustedArgvChange(deps(dir), { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] });
    expect(result).toBeNull();
  });

  it("returns null when a trusted author changed an active criterion's argv", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const head = commit(dir, "change argv");
    const result = findUntrustedArgvChange(
      deps(dir, {
        "commits/[0-9a-f]+ --jq \\.author\\.login": "trusted-owner",
        "collaborators/trusted-owner/permission": "ADMIN",
      }),
      { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] },
    );
    expect(result).toBeNull();
  });

  it("flags an untrusted author's argv change, naming the commit and criterion", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const head = commit(dir, "change argv");
    const result = findUntrustedArgvChange(
      deps(dir, {
        "commits/[0-9a-f]+ --jq \\.author\\.login": "outside-contributor",
        "collaborators/outside-contributor/permission": "READ",
      }),
      { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] },
    );
    expect(result).toEqual({ commit: head, specPath: "docs/specs/example/spec.json", criterionId: "AC-1", login: "outside-contributor", association: "COLLABORATOR" });
  });

  it("fails closed when the commit's author cannot be attributed to a GitHub login", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const head = commit(dir, "change argv");
    const result = findUntrustedArgvChange(deps(dir, { "commits/[0-9a-f]+ --jq \\.author\\.login": "null" }), { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] });
    expect(result).toMatchObject({ login: null, association: null });
  });

  it("returns null when the active criterion's argv is unchanged even though the spec file changed", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"], given: "g1" }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"], given: "g2 — only prose changed" }]);
    const head = commit(dir, "change prose, not argv");
    const result = findUntrustedArgvChange(deps(dir), { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] });
    expect(result).toBeNull();
  });

  it("fails closed when the GitHub commit lookup itself fails", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const head = commit(dir, "change argv");
    // No fake gh responses, so the commit lookup throws.
    const result = findUntrustedArgvChange(deps(dir), { baseSha: base, headSha: head, repo: "o/r", trustedAssociations: ["OWNER"] });
    expect(result).toEqual({ commit: head, specPath: "docs/specs/example/spec.json", criterionId: "AC-1", login: null, association: null });
  });

  it("fails closed when the permission lookup fails for an attributed author", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const head = commit(dir, "change argv");
    // The commit resolves to a login, but no fake permission response exists, so that lookup throws.
    const result = findUntrustedArgvChange(deps(dir, { "commits/[0-9a-f]+ --jq \\.author\\.login": "known-author" }), {
      baseSha: base,
      headSha: head,
      repo: "o/r",
      trustedAssociations: ["OWNER"],
    });
    expect(result).toEqual({ commit: head, specPath: "docs/specs/example/spec.json", criterionId: "AC-1", login: "known-author", association: null });
  });
});
