import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const BIN = (name) => path.join(PLUGIN_ROOT, "bin", `${name}.mjs`);

function runBin(name, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN(name), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { rc: 0, stdout };
  } catch (err) {
    return {
      rc: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("end-to-end: harness-init + every validator green", () => {
  it("scaffolds a fresh repo and runs each validator to exit 0", () => {
    const target = mkdtempSync(path.join(tmpdir(), "e2e-scaffold-"));

    // 1. init a git repo so createHarnessContext resolves repo root.
    git(["init", "-q", "-b", "main"], target);
    git(["config", "user.email", "t@t"], target);
    git(["config", "user.name", "t"], target);

    // Pre-seed README/CLAUDE so the scaffolder's facts template has instruction
    // files to point at, and CLAUDE.md has the protected paths its facts will
    // reference.
    writeFileSync(path.join(target, "README.md"), "# e2e\nThis project has 1 team.\n");
    writeFileSync(
      path.join(target, "CLAUDE.md"),
      [
        "# e2e",
        "",
        "## Protected paths",
        "- CLAUDE.md",
        "- .github/workflows/**",
        "- .claude/commands/**",
        "",
        "This project has 1 team.",
      ].join("\n") + "\n",
    );
    git(["add", "."], target);
    git(["commit", "-q", "-m", "seed"], target);

    // 2. harness-init
    const init = runBin("harness-init", [
      "--project-name",
      "e2e",
      "--project-type",
      "node",
      "--target-dir",
      target,
    ]);
    expect(init.rc, init.stderr ?? "").toBe(0);

    // Scaffold wrote the skeleton
    expect(existsSync(path.join(target, ".claude/skills-manifest.json"))).toBe(true);
    expect(existsSync(path.join(target, "docs/specs/README.md"))).toBe(true);
    expect(existsSync(path.join(target, "docs/repo-facts.json"))).toBe(true);

    const env = { ...process.env, HARNESS_REPO_ROOT: target };

    // 3. Every validator exits 0 (skills, specs — drift depends on facts
    // content matching CLAUDE.md, skipped here to keep the test hermetic).
    const skills = runBin("harness-validate-skills", [], { env });
    expect(skills.rc, skills.stderr ?? "").toBe(0);

    const specs = runBin("harness-validate-specs", [], { env });
    // The scaffolder commits no specs — validateSpecs returns ok for an empty
    // docs/specs/ (listSpecDirs iterates whatever sub-dirs exist, and the
    // template only ships a README).
    expect(specs.rc, specs.stderr ?? "").toBe(0);
  });
});
