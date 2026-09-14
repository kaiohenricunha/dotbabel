import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const bin = path.join(repoRoot, "plugins/dotbabel/bin/dotbabel-criteria.mjs");
const dotbabelBin = path.join(repoRoot, "plugins/dotbabel/bin/dotbabel.mjs");
const NODE = process.execPath;
const FAKE_GH_SOURCE = fs.readFileSync(path.join(__dirname, "fixtures/fake-gh.mjs"), "utf8");

function schema(name) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", name), "utf8"));
}

function validatorFor(name) {
  return new Ajv.default({ strict: false }).compile(schema(name));
}

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A temp bin/ directory holding a fake `gh`, ready to be prepended to PATH. */
function fakeGhBinDir() {
  const dir = tmp("criteria-cli-fakegh-");
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(ghPath, FAKE_GH_SOURCE, { mode: 0o755 });
  return dir;
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function initGitRepo() {
  const dir = tmp("criteria-cli-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function writeSpec(dir, criteria, specId = "example") {
  const specDir = path.join(dir, "docs", "specs", specId);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    path.join(specDir, "spec.json"),
    JSON.stringify(
      {
        id: specId,
        title: "Example",
        status: "approved",
        owners: ["Tester"],
        linked_paths: ["CLAUDE.md"],
        acceptance_commands: ["echo ok"],
        acceptance_criteria: criteria,
        depends_on_specs: [],
        active_prs: [],
      },
      null,
      2,
    ),
  );
}

/** Write a spec.json at a repository-relative directory outside docs/specs/. */
function writeSpecOutsideSpecs(dir, relDir, criteria) {
  const specDir = path.join(dir, relDir);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify({ id: path.basename(relDir), acceptance_criteria: criteria }));
}

function writeTestFile(dir, relPath, contents) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function nodeScriptArgv(script) {
  return [NODE, "-e", script];
}

/** An argv that records that it ran by writing `markerPath`, then prints `output`. */
function markingArgv(markerPath, output = "passes") {
  return nodeScriptArgv(`require('fs').writeFileSync(${JSON.stringify(markerPath)}, '1'); process.stdout.write(${JSON.stringify(`${output}\n`)})`);
}

function criterion(id, argv, extra = {}) {
  return { id, given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv, ...extra };
}

function run(dir, args, { env = {}, pathDirs = [] } = {}) {
  const PATH = [...pathDirs, process.env.PATH].join(path.delimiter);
  return spawnSync(NODE, [bin, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env, PATH } });
}

/** Trust comes only from these variables, never from the developer's shell or allowlist. */
function untrustedEnv(dir) {
  return { CHECK_ON_STOP_TRUSTED_FILE: path.join(dir, "no-such-trust-file"), CHECK_ON_STOP_TRUST_ALL: "" };
}

function prEnv({ headSha, baseSha = headSha, body = "## Spec ID\n\nexample\n", ...rest }) {
  return { CHECK_ON_STOP_TRUST_ALL: "1", FAKE_GH_HEAD_SHA: headSha, FAKE_GH_BASE_SHA: baseSha, FAKE_GH_BODY: body, ...rest };
}

describe("dotbabel criteria list", () => {
  it("lists the criteria of a spec as JSON", () => {
    const dir = initGitRepo();
    writeSpec(dir, [
      { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] },
      { id: "AC-2", status: "planned", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "other" }], argv: [NODE, "-e", "process.exit(0)"] },
    ]);
    const result = run(dir, ["list", "--spec", "example", "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.specs).toEqual([
      {
        id: "example",
        criteria: [
          { id: "AC-1", status: "active", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] },
          { id: "AC-2", status: "planned", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "other" }], argv: [NODE, "-e", "process.exit(0)"] },
        ],
      },
    ]);
  });

  it("prints criteria list JSON that validates against the criteria list schema", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    const result = run(dir, ["list", "--spec", "example", "--json"]);
    expect(result.status).toBe(0);
    const validate = validatorFor("dotbabel.criteria-list.schema.json");
    const ok = validate(JSON.parse(result.stdout));
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it("exits 2 for an unknown spec", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    const result = run(dir, ["list", "--spec", "does-not-exist"]);
    expect(result.status).toBe(2);
  });

  it("lists every spec's criteria when --spec is omitted", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }], "example-a");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }], "example-b");
    const result = run(dir, ["list", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).specs.map((s) => s.id)).toEqual(["example-a", "example-b"]);
  });
});

describe("dotbabel criteria verify — usage errors", () => {
  it("exits 64 when --post is used without --pr", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    const result = run(dir, ["verify", "--spec", "example", "--post"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/--post requires --pr/);
  });

  it("exits 64 when --timeout is 0 or 3601", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    for (const value of ["0", "3601"]) {
      const result = run(dir, ["verify", "--spec", "example", "--timeout", value]);
      expect(result.status, `--timeout ${value}`).toBe(64);
      expect(result.stderr, `--timeout ${value}`).toMatch(/--timeout must be an integer from 1 through 3600/);
    }
  });

  it("exits 64 when --pr is not a positive integer", () => {
    const dir = initGitRepo();
    const ghDir = fakeGhBinDir();
    for (const value of ["abc", "0", "1.5"]) {
      const result = run(dir, ["verify", "--pr", value], { pathDirs: [ghDir] });
      expect(result.status, `--pr ${value}`).toBe(64);
      expect(result.stderr, `--pr ${value}`).toMatch(/--pr must be a positive integer/);
    }
  });

  it("exits 64 when a --pass-env name is not a valid environment variable name", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--pass-env", "1BAD"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/--pass-env/);
  });

  it("exits 64 for a --criterion id that the spec does not declare, without running anything", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    const marker = path.join(dir, "ran.txt");
    writeSpec(dir, [criterion("AC-1", markingArgv(marker))]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--criterion", "AC-99"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unknown --criterion id/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("dotbabel criteria verify — outcomes", () => {
  it("exits 0 with a notice when no linked spec declares an active criterion", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", status: "planned", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/no linked spec declares an active criterion/);
  });

  it("prints exactly one JSON document on stdout under --json when no criterion is active", () => {
    const dir = initGitRepo();
    writeSpec(dir, [criterion("AC-1", [NODE, "-e", "process.exit(0)"], { status: "planned" })]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).specs[0].criteria).toEqual([{ id: "AC-1", status: "pending" }]);
    expect(result.stderr).toMatch(/no linked spec declares an active criterion/);
  });

  it("exits 1 when any criterion fails", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.exit(1)") }]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).verdict).toBe("fail");
  });

  it("exits 2 when the repository is untrusted and --allow-project-commands is absent", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.stdout.write('passes\\n')") }]);
    const result = run(dir, ["verify", "--spec", "example"], { env: untrustedEnv(dir) });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/trust is required/);
  });

  it("exits 2 for an unknown --spec", () => {
    const dir = initGitRepo();
    const result = run(dir, ["verify", "--spec", "does-not-exist", "--allow-project-commands"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown spec/);
  });

  it("exits 2 for a --spec that points outside docs/specs/, without running its argv", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const marker = path.join(dir, "ran.txt");
    writeSpecOutsideSpecs(dir, "evil", [criterion("AC-1", markingArgv(marker))]);
    const result = run(dir, ["verify", "--spec", "../../evil", "--allow-project-commands"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown spec/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("exits 2 for a symbolic-link spec.json without running its argv", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    const marker = path.join(dir, "ran.txt");
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ id: "example", acceptance_criteria: [criterion("AC-1", markingArgv(marker))] }));
    const specDir = path.join(dir, "docs", "specs", "example");
    fs.mkdirSync(specDir, { recursive: true });
    fs.symlinkSync("../../../outside.json", path.join(specDir, "spec.json"));
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/symbolic link/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("prints a payload that validates against the criteria evidence schema", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes\n// fails\n// silent");
    writeSpec(dir, [
      criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')")),
      { ...criterion("AC-2", nodeScriptArgv("process.exit(1)")), tests: [{ file: "t.mjs", name: "fails" }] },
      { ...criterion("AC-3", nodeScriptArgv("process.exit(0)")), tests: [{ file: "t.mjs", name: "silent" }] },
      { ...criterion("AC-4", nodeScriptArgv("process.exit(0)")), tests: [{ file: "missing.mjs", name: "passes" }] },
      criterion("AC-5", nodeScriptArgv("process.exit(0)"), { status: "planned" }),
    ]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--json"]);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.specs[0].criteria.map((c) => c.status)).toEqual(["pass", "fail", "unconfirmed", "error", "pending"]);
    const validate = validatorFor("dotbabel.criteria-evidence.schema.json");
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("passes only the variables named by --pass-env to criterion commands", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// checks env");
    const outFile = path.join(dir, "env-check.json");
    writeSpec(dir, [
      {
        id: "AC-1",
        given: "g",
        when: "w",
        then: "t",
        tests: [{ file: "t.mjs", name: "checks env" }],
        argv: nodeScriptArgv(
          `require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({one: process.env.CRITERIA_TEST_ONE ?? null, two: process.env.CRITERIA_TEST_TWO ?? null})); process.stdout.write('checks env\\n')`,
        ),
      },
    ]);
    const result = run(dir, ["verify", "--spec", "example", "--allow-project-commands", "--pass-env", "CRITERIA_TEST_ONE"], {
      env: { CRITERIA_TEST_ONE: "value-one", CRITERIA_TEST_TWO: "value-two" },
    });
    expect(result.status).toBe(0);
    const seen = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(seen).toEqual({ one: "value-one", two: null });
  });
});

describe("dotbabel criteria verify --pr preconditions", () => {
  it("exits 2 when local HEAD differs from the pull request head", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.exit(0)") }]);
    commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], {
      env: { CHECK_ON_STOP_TRUST_ALL: "1", FAKE_GH_HEAD_SHA: "0".repeat(40), FAKE_GH_BASE_SHA: "1".repeat(40) },
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/differs from PR/);
  });

  it("exits 2 when the worktree has uncommitted changes outside .dotbabel/", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.exit(0)") }]);
    commitAll(dir, "base");
    fs.writeFileSync(path.join(dir, "t.mjs"), "// passes, but now dirty");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], {
      env: { CHECK_ON_STOP_TRUST_ALL: "1" },
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/uncommitted changes outside \.dotbabel\//);
  });

  it("exits 2 for a pull request from a fork unless --allow-project-commands is set", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.stdout.write('passes\\n')") }]);
    const headSha = commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const baseEnv = prEnv({ headSha, FAKE_GH_IS_FORK: "1" });

    const blocked = run(dir, ["verify", "--pr", "1"], { env: baseEnv, pathDirs: [ghDir] });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/comes from a fork/);

    // Genuinely proves the override worked, not merely "didn't exit 2 for
    // some other reason" (e.g. a body extraction bug that skips verifying
    // anything would also produce a non-2 exit and pass a weaker assertion).
    const overridden = run(dir, ["verify", "--pr", "1", "--allow-project-commands", "--json"], { env: baseEnv, pathDirs: [ghDir] });
    expect(overridden.status).toBe(0);
    const payload = JSON.parse(overridden.stdout);
    expect(payload.verdict).toBe("pass");
    expect(payload).toMatchObject({ head_sha: headSha, pr: 1 });
    const validate = validatorFor("dotbabel.criteria-evidence.schema.json");
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("exits 2 when an untrusted author changed an active criterion's argv", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.exit(0)") }]);
    const baseSha = commitAll(dir, "base");
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.exit(1) /* changed */") }]);
    const headSha = commitAll(dir, "change argv");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], {
      env: prEnv({ headSha, baseSha, FAKE_GH_PR_ASSOCIATION: "CONTRIBUTOR" }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/AC-1/);
    expect(result.stderr).toMatch(/CONTRIBUTOR/);
  });

  it("accepts an argv change when the pull request author's association is trusted", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const baseSha = commitAll(dir, "base");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n') /* changed */"))]);
    const headSha = commitAll(dir, "change argv");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1", "--json"], {
      env: prEnv({ headSha, baseSha, FAKE_GH_PR_ASSOCIATION: "OWNER" }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
  });

  it("judges trust with the criteria config at the pull request base, not the head", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const baseSha = commitAll(dir, "base");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n') /* changed */"))]);
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify({ criteria: { trusted_associations: ["OWNER", "CONTRIBUTOR"] } }));
    const headSha = commitAll(dir, "change argv and widen trust in the same pull request");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], {
      env: prEnv({ headSha, baseSha, FAKE_GH_PR_ASSOCIATION: "CONTRIBUTOR" }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/CONTRIBUTOR/);
  });

  it("passes only the pass_env names from the base config in --pr mode", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// checks env");
    const outFile = path.join(dir, "env-check.json");
    writeSpec(dir, [
      {
        ...criterion(
          "AC-1",
          nodeScriptArgv(`require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({secret: process.env.CRITERIA_SECRET ?? null})); process.stdout.write('checks env\\n')`),
        ),
        tests: [{ file: "t.mjs", name: "checks env" }],
      },
    ]);
    const baseSha = commitAll(dir, "base");
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify({ criteria: { pass_env: ["CRITERIA_SECRET"] } }));
    const headSha = commitAll(dir, "widen pass_env in the pull request");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1", "--allow-project-commands"], {
      env: prEnv({ headSha, baseSha, CRITERIA_SECRET: "s3cret" }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outFile, "utf8"))).toEqual({ secret: null });
  });

  it("exits 2 for a Spec ID in the pull request body that points outside docs/specs/", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const marker = path.join(dir, "ran.txt");
    writeSpecOutsideSpecs(dir, "evil", [criterion("AC-1", markingArgv(marker))]);
    const headSha = commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], {
      env: prEnv({ headSha, body: "## Spec ID\n\n../../evil\n" }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown spec/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("never runs a shell for git data: a spec directory named with shell metacharacters creates no file", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const baseSha = commitAll(dir, "base");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.exit(0)"))], "evil;touch>PWNED;#");
    const headSha = commitAll(dir, "add a spec whose directory name holds shell metacharacters");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1"], { env: prEnv({ headSha, baseSha }), pathDirs: [ghDir] });
    expect(fs.existsSync(path.join(dir, "PWNED"))).toBe(false);
    expect(result.status).toBe(0);
  });

  it("never posts evidence for a --criterion subset run", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes\n// other");
    writeSpec(dir, [
      { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: nodeScriptArgv("process.stdout.write('passes\\n')") },
      { id: "AC-2", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "other" }], argv: nodeScriptArgv("process.stdout.write('other\\n')") },
    ]);
    const headSha = commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const postLog = path.join(dir, "posts.log");
    const result = run(dir, ["verify", "--pr", "1", "--criterion", "AC-1", "--post", "--json"], {
      env: prEnv({ headSha, FAKE_GH_POST_LOG: postLog }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(0);
    // Proves the run actually verified AC-1 (not a body-extraction bug that
    // skipped verification entirely, which would also leave posts.log absent).
    expect(JSON.parse(result.stdout).specs[0].criteria).toEqual([{ id: "AC-1", status: "pass", argv: expect.any(Array), exit_code: 0, duration_ms: expect.any(Number), timed_out: false, truncated: false, tests: expect.any(Array), output_sha256: expect.any(String) }]);
    expect(fs.existsSync(postLog)).toBe(false);
  });

  it("posts one evidence comment that keeps the output of two linked specs with the same criterion id apart", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes output-from-a\\n')"))], "spec-a");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes output-from-b\\n')"))], "spec-b");
    const headSha = commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const postLog = path.join(dir, "posts.log");
    const postBody = path.join(dir, "post-body.md");
    const result = run(dir, ["verify", "--pr", "1", "--post", "--json"], {
      env: prEnv({ headSha, body: "## Spec ID\n\nspec-a spec-b\n", FAKE_GH_POST_LOG: postLog, FAKE_GH_POST_BODY: postBody }),
      pathDirs: [ghDir],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).specs.map((spec) => spec.id)).toEqual(["spec-a", "spec-b"]);
    expect(fs.readFileSync(postLog, "utf8").split("\n").filter((line) => /--method POST/.test(line))).toHaveLength(1);
    const body = fs.readFileSync(postBody, "utf8");
    expect(body).toContain("spec-a AC-1 output");
    expect(body).toContain("output-from-a");
    expect(body).toContain("spec-b AC-1 output");
    expect(body).toContain("output-from-b");
  });

  it("prints one JSON document with no specs when the pull request body names no Spec ID", () => {
    const dir = initGitRepo();
    writeTestFile(dir, "t.mjs", "// passes");
    writeSpec(dir, [criterion("AC-1", nodeScriptArgv("process.stdout.write('passes\\n')"))]);
    const headSha = commitAll(dir, "base");
    const ghDir = fakeGhBinDir();
    const result = run(dir, ["verify", "--pr", "1", "--json"], { env: prEnv({ headSha, body: "" }), pathDirs: [ghDir] });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).specs).toEqual([]);
    expect(result.stderr).toMatch(/no linked spec declares an active criterion/);
  });
});

describe("dotbabel criteria: help and version (spec's own <verify> block)", () => {
  it("prints usage for --help", () => {
    const result = spawnSync(NODE, [bin, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dotbabel criteria/);
  });

  it("joins dotbabel.mjs's subcommand dispatch", () => {
    const dir = initGitRepo();
    writeSpec(dir, [{ id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [NODE, "-e", "process.exit(0)"] }]);
    const result = spawnSync(NODE, [dotbabelBin, "criteria", "list", "--spec", "example", "--json"], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).specs[0].id).toBe("example");
  });
});
