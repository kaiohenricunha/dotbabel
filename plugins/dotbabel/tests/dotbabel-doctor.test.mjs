import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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

function runDoctor({ home, codexHome, geminiHome, extraPath }) {
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

  const result = spawnSync(process.execPath, [DOCTOR, "--repo-root", REPO_ROOT], {
    env,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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
    const emptyStub = makeTmpDir("empty-stub-");

    // Build a PATH that excludes any real codex/gemini install. We invoke node
    // by absolute path (process.execPath) so node doesn't need to be on PATH.
    // Keep /usr/bin + /bin for git only.
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${emptyStub}:/usr/bin:/bin`,
    };
    delete env.CODEX_HOME;
    delete env.GEMINI_HOME;

    const result = spawnSync(process.execPath, [DOCTOR, "--repo-root", REPO_ROOT], {
      env,
      encoding: "utf8",
    });

    // Sanity: doctor produced output.
    expect(typeof result.stdout).toBe("string");

    // The fan-out lines should NOT appear because both gates are closed.
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
});
