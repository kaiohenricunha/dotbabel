import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "..", "scripts", "detect-branch-drift.mjs");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Stand up a tmp git repo with:
 *   main:    `.claude/commands/<commandFile>` committed
 *   origin/main: same as main (push+pull to a bare remote)
 */
function makeRepo({ commandFile = "example.md" } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "dbd-work-"));
  const bare = `${work}-bare.git`;

  git(["init", "-q", "-b", "main"], work);
  git(["config", "user.email", "t@t"], work);
  git(["config", "user.name", "t"], work);

  mkdirSync(path.join(work, ".claude/commands"), { recursive: true });
  writeFileSync(path.join(work, ".claude/commands", commandFile), "# seed\n");
  git(["add", "."], work);
  git(["commit", "-q", "-m", "seed"], work);

  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-q", "-u", "origin", "main"], work);

  return { work, bare };
}

function runScript(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { rc: 0, stdout };
  } catch (err) {
    return { rc: err.status ?? 1, stdout: err.stdout?.toString() ?? "" };
  }
}

describe("detect-branch-drift.mjs", () => {
  it("reports 'no drift detected' when HEAD == origin/main", () => {
    const { work } = makeRepo();
    const { rc, stdout } = runScript(work);
    expect(rc).toBe(0);
    expect(stdout).toMatch(/no drift/i);
  });

  it("reports diverged rows when a command has local edits vs origin/main", () => {
    const { work } = makeRepo();
    writeFileSync(path.join(work, ".claude/commands/example.md"), "# diverged\n");
    git(["commit", "-q", "-am", "edit"], work);
    // Do NOT push — origin/main is still at the seed commit.

    const { rc, stdout } = runScript(work);
    expect(rc).toBe(0);
    expect(stdout).toMatch(/DIVERGED/);
    expect(stdout).toMatch(/example\.md\s+yes/);
  });

  it("exits 0 when there are no .claude/commands/ files on HEAD", () => {
    const work = mkdtempSync(path.join(tmpdir(), "dbd-empty-"));
    git(["init", "-q", "-b", "main"], work);
    git(["config", "user.email", "t@t"], work);
    git(["config", "user.name", "t"], work);
    writeFileSync(path.join(work, "README.md"), "x\n");
    git(["add", "."], work);
    git(["commit", "-q", "-m", "seed"], work);

    const { rc, stdout } = runScript(work);
    expect(rc).toBe(0);
    expect(stdout).toMatch(/no drift/i);
  });
});
