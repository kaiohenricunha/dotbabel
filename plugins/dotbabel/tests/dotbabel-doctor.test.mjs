import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Spawn the bin as a child process — dotbabel-doctor.mjs runs all checks at
// module top-level and calls process.exit, so importing it would terminate
// the test runner.

let tmpDirs = [];

function makeTmpDir(prefix = "doctor-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DOCTOR = path.join(REPO_ROOT, "plugins", "dotbabel", "bin", "dotbabel-doctor.mjs");

function stubBinsOnPath(...names) {
  const stubDir = makeTmpDir("stub-bin-");
  for (const name of names) {
    const stubPath = path.join(stubDir, name);
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return stubDir;
}

function runDoctor({
  home,
  codexHome,
  geminiHome,
  antigravityHome,
  extraPath,
  trustedFile,
  repoRoot,
  shellPrefix,
  json = false,
}) {
  // Build a hermetic PATH that does NOT inherit the user's PATH (which on a
  // dev machine likely contains a real codex/gemini install in nvm's bin dir).
  // We invoke node by absolute path so node doesn't need to be on PATH.
  const env = {
    ...process.env,
    HOME: home,
    PATH: extraPath ? `${extraPath}:/usr/bin:/bin` : "/usr/bin:/bin",
  };
  if (codexHome) env.CODEX_HOME = codexHome;
  else delete env.CODEX_HOME;
  if (geminiHome) env.GEMINI_HOME = geminiHome;
  else delete env.GEMINI_HOME;
  if (antigravityHome) env.ANTIGRAVITY_CONFIG_HOME = antigravityHome;
  else delete env.ANTIGRAVITY_CONFIG_HOME;
  // The trust check resolves ${XDG_CONFIG_HOME:-$HOME/.config}, so a temp HOME
  // alone is not enough — an exported XDG_CONFIG_HOME would send the check at
  // the developer's real allowlist and make output machine-dependent.
  delete env.XDG_CONFIG_HOME;
  delete env.CHECK_ON_STOP_TRUST_ALL;
  if (trustedFile) env.CHECK_ON_STOP_TRUSTED_FILE = trustedFile;
  else delete env.CHECK_ON_STOP_TRUSTED_FILE;
  // The hook registration check reads the user settings from CLAUDE_CONFIG_DIR
  // and the shell prefix from the environment. A Claude Code session exports
  // both, so inheriting them would make the output depend on the developer.
  delete env.CLAUDE_CONFIG_DIR;
  if (shellPrefix) env.CLAUDE_CODE_SHELL_PREFIX = shellPrefix;
  else delete env.CLAUDE_CODE_SHELL_PREFIX;

  const args = [DOCTOR, "--repo-root", repoRoot ?? REPO_ROOT, ...(json ? ["--json"] : [])];
  const result = spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// Doctor with --json. Its envelope is the last JSON document on stdout: an
// earlier check can print one of its own.
function runDoctorJson(opts) {
  const res = runDoctor({ ...opts, json: true });
  return JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('{\n  "events"')));
}

// A throwaway repo root carrying only docs/repo-facts.json with the given
// contents. Enough for doctor's facts section; the checks below it degrade to
// warnings on the missing manifest/specs, which is what we want here.
function repoWithFacts(contents) {
  const root = makeTmpDir("doctor-facts-");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "repo-facts.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2) + "\n",
  );
  return root;
}

describe("dotbabel-doctor fan-out check", () => {
  it("warns when codex skill fan-out sentinel is missing (and codex is on PATH)", () => {
    const home = makeTmpDir("home-");
    // Codex on PATH, but no fan-out symlinks created.
    const stub = stubBinsOnPath("codex");

    const result = runDoctor({ home, extraPath: stub });

    expect(result.stdout).toMatch(/Codex skills fan-out/);
    expect(result.stdout + result.stderr).toMatch(
      /Codex skills fan-out missing|run 'dotbabel bootstrap --all'/i,
    );
  });

  it("passes when codex skill fan-out sentinel resolves", () => {
    const home = makeTmpDir("home-");
    // Codex on PATH.
    const stub = stubBinsOnPath("codex");

    // Create the sentinel symlink: <home>/.codex/skills/changelog/SKILL.md
    // -> <REPO_ROOT>/commands/changelog.md (mirrors the real fan-out).
    const dst = path.join(home, ".codex", "skills", "changelog");
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "commands", "changelog.md"), path.join(dst, "SKILL.md"));

    const result = runDoctor({ home, extraPath: stub });

    expect(result.stdout).toMatch(/Codex skills fan-out (present|sentinel)/i);
  });

  it("skips codex fan-out check when codex is NOT on PATH", () => {
    const home = makeTmpDir("home-");
    // Empty stub dir on PATH — neither codex nor gemini resolve.
    const emptyStub = makeTmpDir("empty-stub-");

    const result = runDoctor({ home, extraPath: emptyStub });

    expect(typeof result.stdout).toBe("string");
    expect(result.stdout).not.toMatch(/Codex skills fan-out/);
    expect(result.stdout).not.toMatch(/Gemini skills fan-out/);
  });

  it("honors GEMINI_HOME for the gemini fan-out check", () => {
    const home = makeTmpDir("home-");
    const customGemini = makeTmpDir("custom-gemini-");
    const stub = stubBinsOnPath("gemini");

    // Create sentinel under the OVERRIDE path, not the default.
    const dst = path.join(customGemini, "skills", "changelog");
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "commands", "changelog.md"), path.join(dst, "SKILL.md"));

    const result = runDoctor({ home, geminiHome: customGemini, extraPath: stub });

    expect(result.stdout).toMatch(/Gemini skills fan-out (present|sentinel)/i);
  });

  // Antigravity's diagnostics came for free from the registry-driven loop —
  // doctor gained no Antigravity-specific code. These pin that it reports on the
  // `agy` binary, not on an `antigravity` one that never exists.
  it("reports the antigravity fan-out when agy is on PATH", () => {
    const home = makeTmpDir("home-");
    const customRoot = makeTmpDir("custom-antigravity-");
    const stub = stubBinsOnPath("agy");

    const dst = path.join(customRoot, "skills", "changelog");
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "commands", "changelog.md"), path.join(dst, "SKILL.md"));

    const result = runDoctor({ home, antigravityHome: customRoot, extraPath: stub });

    expect(result.stdout).toMatch(/Antigravity skills fan-out (present|sentinel)/i);
  });

  it("stays silent about antigravity when agy is absent", () => {
    const home = makeTmpDir("home-");
    const stub = stubBinsOnPath("gemini");

    const result = runDoctor({ home, extraPath: stub });

    expect(result.stdout).not.toMatch(/Antigravity skills fan-out/);
  });

  it("does not probe for a binary named after the runtime id", () => {
    const home = makeTmpDir("home-");
    // An `antigravity` executable exists but `agy` does not: detection keys off
    // the registry's detect list, so this must NOT count as installed.
    const stub = stubBinsOnPath("antigravity");

    const result = runDoctor({ home, extraPath: stub });

    expect(result.stdout).not.toMatch(/Antigravity skills fan-out/);
  });
});

describe("dotbabel-doctor hook registration check", () => {
  function writeSettings(dir, name, value) {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude", name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const command = (cmd) => ({ hooks: [{ type: "command", command: cmd }] });

  it("lists registered hooks with their events and warns once per unregistered hook", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });
    writeSettings(home, "settings.json", {
      hooks: { PreToolUse: [command("$HOME/.claude/hooks/guard-destructive-git.sh")] },
    });
    writeSettings(repoRoot, "settings.json", {
      hooks: { PreToolUse: [command(".claude/hooks/guard-criteria-evidence.sh")] },
    });

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).toMatch(
      /hooks registered: guard-criteria-evidence\.sh \(PreToolUse; project\), guard-destructive-git\.sh \(PreToolUse; user\)/,
    );
    expect(res.stdout).toMatch(/check-on-write\.sh is shipped but not registered — expects PostToolUse/);
    expect(res.stdout).toMatch(/check-on-stop\.sh is shipped but not registered — expects Stop/);
    expect(res.stdout).toMatch(
      /fleet-shell-prefix\.sh is shipped but not registered — expects CLAUDE_CODE_SHELL_PREFIX/,
    );
    expect(res.stdout).toMatch(/task-context\.sh is shipped but not registered — expects SessionStart/);
    expect(res.stdout.match(/is shipped but not registered/g)).toHaveLength(5);
  });

  it("never fails the run for an unregistered or partly registered hook", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });
    writeSettings(home, "settings.json", {
      hooks: { PreToolUse: [command("$HOME/.claude/hooks/fleet-guard.sh pre-edit")] },
    });
    const res = runDoctorJson({ home, repoRoot });
    const hookEvents = res.events.filter((e) => e.message.startsWith("hooks"));
    expect(hookEvents.length).toBeGreaterThan(3);
    expect(hookEvents.some((e) => e.kind === "warn")).toBe(true);
    expect(hookEvents.filter((e) => e.kind === "fail")).toEqual([]);
  });

  it("prints no control character from a hostile settings key", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });
    writeSettings(repoRoot, "settings.json", '{"hooks":{"PreToolUse\\u001b[3A\\n  ok":[{"hooks":[{"type":"command","command":"x/guard-destructive-git.sh"}]}]}}');
    const res = runDoctor({ home, repoRoot });
    expect(res.stdout).not.toMatch(/\u001b\[3A/);
    expect(res.stdout).toMatch(/hooks key that is not an event name/);
  });

  it("names the events a partly registered hook still lacks", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });
    writeSettings(home, "settings.json", {
      hooks: { PreToolUse: [command("$HOME/.claude/hooks/fleet-guard.sh pre-edit")] },
    });

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).toMatch(/fleet-guard\.sh \(PreToolUse; user\)/);
    expect(res.stdout).toMatch(
      /fleet-guard\.sh is registered for PreToolUse but not for PreToolUse \(pre-bash\), SessionStart \(session-start\), PostToolUse \(post-tool\), UserPromptSubmit \(prompt\)/,
    );
  });

  it("counts the shell prefix from the environment", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });

    const res = runDoctor({ home, repoRoot, shellPrefix: "/opt/hooks/fleet-shell-prefix.sh" });

    expect(res.stdout).toMatch(/hooks registered: fleet-shell-prefix\.sh \(CLAUDE_CODE_SHELL_PREFIX\)/);
    expect(res.stdout).not.toMatch(/fleet-shell-prefix\.sh is shipped but not registered/);
  });

  it("warns about an unparseable settings file by name", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ protected_paths: [] });
    writeSettings(repoRoot, "settings.local.json", "{ not json");

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).toContain(path.join(repoRoot, ".claude", "settings.local.json"));
    expect(res.stdout).toMatch(/settings\.local\.json.*does not parse/);
  });

  it("never changes the exit code", () => {
    const repoRoot = repoWithFacts({ protected_paths: [] });
    const bare = runDoctor({ home: makeTmpDir("home-"), repoRoot });

    const home = makeTmpDir("home-");
    writeSettings(home, "settings.json", "{ not json");
    const broken = runDoctor({ home, repoRoot });

    expect(bare.stdout).toMatch(/is shipped but not registered/);
    expect(broken.status).toBe(bare.status);
  });
});

describe("dotbabel-doctor check-on-stop trust check", () => {
  it("warns when the repo is not on the allowlist", () => {
    const home = makeTmpDir("home-");
    const trustedFile = path.join(makeTmpDir("trust-"), "trusted");
    fs.writeFileSync(trustedFile, "", "utf8");

    const res = runDoctor({ home, trustedFile });

    expect(res.stdout).toMatch(/NOT on the trust allowlist/);
  });

  it("passes when the repo is on the allowlist, without changing the exit code", () => {
    const home = makeTmpDir("home-");
    const trustedDir = makeTmpDir("trust-");
    const untrusted = path.join(trustedDir, "empty");
    const trusted = path.join(trustedDir, "trusted");
    fs.writeFileSync(untrusted, "", "utf8");
    fs.writeFileSync(trusted, `${fs.realpathSync(REPO_ROOT)}\n`, "utf8");

    const before = runDoctor({ home, trustedFile: untrusted });
    const after = runDoctor({ home, trustedFile: trusted });

    expect(after.stdout).toMatch(/is on the trust allowlist/);
    // The check must never contribute a failure: a repo deliberately left off
    // the allowlist is a valid state, and reddening doctor for it would train
    // people to ignore doctor.
    expect(after.status).toBe(before.status);
  });

  it("reports informationally when no allowlist exists at all", () => {
    const home = makeTmpDir("home-");
    const trustedFile = path.join(makeTmpDir("trust-"), "absent");

    const res = runDoctor({ home, trustedFile });

    expect(res.stdout).toMatch(/no trust allowlist at/);
  });
});

// OPS-6 is phrased about the command ("`dotbabel doctor` warns when
// docs/repo-facts.json gives regression_paths or verification_commands a
// non-empty value"), so it is asserted here, against the bin, rather than
// only against checkRemovedRepoFactsKeys in repo-facts-keys.test.mjs. Without
// these, deleting doctor's call site would leave that file's tests green.
describe("dotbabel-doctor removed repo-facts keys (OPS-6)", () => {
  it("doctor warns when repo-facts gives regression_paths a non-empty value", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ regression_paths: ["data/**"] });

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).toMatch(/regression_paths/);
    expect(res.stdout).toMatch(/critical_paths/);
  });

  it("doctor warns when repo-facts gives verification_commands a non-empty value", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ verification_commands: ["npm test"] });

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).toMatch(/verification_commands/);
  });

  it("doctor stays silent about removed keys when both are absent or empty", () => {
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts({ regression_paths: [], verification_commands: [] });

    const res = runDoctor({ home, repoRoot });

    expect(res.stdout).not.toMatch(/regression_paths/);
    expect(res.stdout).not.toMatch(/verification_commands/);
  });

  it("doctor reports a malformed repo-facts.json instead of crashing on it", () => {
    // Regression: the removed-keys check was the first unguarded JSON.parse of
    // repo-facts.json in the run, so a malformed file aborted doctor with a raw
    // SyntaxError — skipping every later check and never reaching out.flush(),
    // which makes --json emit nothing at all for exactly the state doctor is
    // reached for.
    const home = makeTmpDir("home-");
    const repoRoot = repoWithFacts("not json at all\n");

    const res = runDoctor({ home, repoRoot });

    expect(res.stderr).not.toMatch(/SyntaxError/);
    expect(res.stdout).toMatch(/docs\/repo-facts\.json does not parse/);
    // Later sections still run rather than being skipped by the abort.
    expect(res.stdout).toMatch(/guard-destructive-git\.sh|skills-manifest\.json/);
  });
});

// A repository that turns on `attestation.enforce` gets a merge gate that
// blocks everything unless its local-attest configuration is coherent, and the
// ways it can be incoherent (no config, an ungoverned config, a required leg
// that does not exist) show up only when a real pull request is stuck. Doctor
// is where they must show up first.
describe("dotbabel-doctor attestation adoption check", () => {
  function repoWithPolicy(dotbabel, files = {}) {
    const root = makeTmpDir("doctor-attest-");
    if (dotbabel !== null)
      fs.writeFileSync(path.join(root, ".dotbabel.json"), JSON.stringify(dotbabel));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
    return root;
  }

  function trustFileFor(root) {
    const file = path.join(makeTmpDir("trust-"), "trusted");
    fs.writeFileSync(file, `${fs.realpathSync(root)}\n`, "utf8");
    return file;
  }

  const untrustedFile = () => {
    const file = path.join(makeTmpDir("trust-"), "empty");
    fs.writeFileSync(file, "", "utf8");
    return file;
  };

  it("stays informational when enforcement is off", () => {
    const root = repoWithPolicy({ attestation: { enforce: false } });
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: untrustedFile(),
    });
    expect(res.stdout).toMatch(/attestation enforcement is off/);
    expect(res.stdout).toMatch(/docs\/attestation\.md/);
    expect(res.stdout).not.toMatch(/NO_CONFIG|ATTESTATION_MISSING/);
  });

  it("says nothing about attestation when the repository has no .dotbabel.json", () => {
    const root = repoWithPolicy(null);
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: untrustedFile(),
    });
    expect(res.stdout).not.toMatch(/attestation enforcement/);
  });

  it("fails when enforcement is on and nothing can produce evidence", () => {
    const root = repoWithPolicy({ attestation: { enforce: true, required_legs: ["test"] } });
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: untrustedFile(),
    });
    expect(res.stdout).toMatch(/no local-attest config/);
    expect(res.status).toBe(1);
  });

  it("does not execute the repository's config when the repository is not trusted", () => {
    const sentinel = path.join(makeTmpDir("sentinel-"), "ran");
    const root = repoWithPolicy(
      { attestation: { enforce: true, required_legs: ["test"] } },
      {
        ".local-attest.config.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "ran");
export default { matrix: [{ name: "test", mode: "hard", command: "true" }] };
`,
      },
    );
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: untrustedFile(),
    });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(res.stdout).toMatch(/legs were not inspected/);
  });

  it("inspects the legs of a trusted repository and reports a required leg that does not exist", () => {
    const sentinel = path.join(makeTmpDir("sentinel-"), "ran");
    const root = repoWithPolicy(
      { attestation: { enforce: true, required_legs: ["test", "quality"] } },
      {
        ".local-attest.config.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "ran");
export default { matrix: [{ name: "test", mode: "hard", command: "true" }] };
`,
      },
    );
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: trustFileFor(root),
    });
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(res.stdout).toMatch(/"quality"/);
    expect(res.stdout).toMatch(/ATTESTATION_INCOMPLETE/);
    expect(res.status).toBe(1);
  });

  it("passes a coherent configuration", () => {
    const root = repoWithPolicy(
      { attestation: { enforce: true, required_legs: ["test"] } },
      {
        ".local-attest.config.mjs": `export default { matrix: [{ name: "test", mode: "hard", command: "true" }] };\n`,
      },
    );
    const res = runDoctor({
      home: makeTmpDir("home-"),
      repoRoot: root,
      trustedFile: trustFileFor(root),
    });
    expect(res.stdout).toMatch(/attestation enforcement is on and its configuration is coherent/);
  });
});
