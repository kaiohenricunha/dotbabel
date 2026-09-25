/**
 * Runs the security-audit artifact promoter's own Go test suite.
 *
 * The promoter is a single Go file with no go.mod on purpose: a module file
 * anywhere in this repository would make `dotbabel quality` discover a Go
 * component (plugins/dotbabel/src/quality/adapters/go.mjs:19 keys on go.mod)
 * and start running gofmt and go test against it. `go test <file> <file>`
 * works in file mode without one.
 *
 * The suite is skipped when no Go toolchain is present, which is the state in
 * this repository's CI. The bats contract test covers what CI can always check:
 * that the file exists and that SKILL.md documents it.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PROMOTER_DIR = join(REPO_ROOT, "skills", "security-audit", "scripts", "promote-artifact");

const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

describe("promote-artifact", () => {
  it("ships as a single Go file with no go.mod beside it", () => {
    expect(existsSync(join(PROMOTER_DIR, "promote-artifact.go"))).toBe(true);
    expect(existsSync(join(PROMOTER_DIR, "promote-artifact_test.go"))).toBe(true);
    // A go.mod here would add a Go component to every `dotbabel quality` run.
    expect(existsSync(join(PROMOTER_DIR, "go.mod"))).toBe(false);
  });

  it.skipIf(!hasGo)("passes its own Go test suite", () => {
    const result = spawnSync("go", ["test", "-count=1", "promote-artifact.go", "promote-artifact_test.go"], {
      cwd: PROMOTER_DIR,
      encoding: "utf8",
      timeout: 120000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 150000);

  it.skipIf(!hasGo)("is gofmt-clean and vets cleanly", () => {
    const formatted = spawnSync("gofmt", ["-l", "."], { cwd: PROMOTER_DIR, encoding: "utf8" });
    expect(formatted.stdout.trim(), "gofmt -l reported files").toBe("");
    const vet = spawnSync("go", ["vet", "promote-artifact.go"], { cwd: PROMOTER_DIR, encoding: "utf8", timeout: 120000 });
    expect(vet.status, vet.stdout + vet.stderr).toBe(0);
  }, 150000);

  it.skipIf(!hasGo)("refuses a symlinked leaf end to end through the CLI", () => {
    // One behavioural check through the real entry point, so the CLI contract
    // the skill documents (JSON on stdout, exit 1 on any refusal) is covered
    // and not only the internal function the Go tests exercise.
    const script = [
      "set -e",
      'work="$(mktemp -d)"',
      'mkdir -p "$work/scratch" "$work/artifacts"',
      'printf secret > "$work/outside.txt"',
      'ln -s "$work/outside.txt" "$work/scratch/sneaky.txt"',
      'printf %s \'{"files":["sneaky.txt"]}\' > "$work/manifest.json"',
      'go run promote-artifact.go --scratch "$work/scratch" --artifacts "$work/artifacts" --manifest "$work/manifest.json" || true',
      'ls "$work/artifacts" | wc -l',
      'rm -rf "$work"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { cwd: PROMOTER_DIR, encoding: "utf8", timeout: 120000 });
    expect(result.stdout, result.stderr).toMatch(/"refused"/);
    expect(result.stdout).toMatch(/sneaky\.txt/);
    // Last line is the artifact count: the symlinked leaf must not be promoted.
    expect(result.stdout.trim().split("\n").pop()).toBe("0");
  }, 150000);
});
