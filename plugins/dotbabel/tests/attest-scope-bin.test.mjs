import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeTempDir } from "./fixtures/temp-dir.mjs";

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");
const node = (bin, args, opts = {}) =>
  spawnSync(process.execPath, [path.join(BIN_DIR, bin), ...args], { encoding: "utf8", ...opts });

describe("dotbabel attest-scope (process level)", () => {
  it("is routed by the umbrella dispatcher", () => {
    const r = node("dotbabel.mjs", ["attest-scope", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--runner <vitest\|jest\|go\|pytest>/);
  });

  it("exits 64 on a usage error and runs nothing", () => {
    const r = node("dotbabel-attest-scope.mjs", ["--runner", "go"]);
    expect(r.status).toBe(64);
  });

  it("runs the CI command unchanged and returns its exit code when local-attest passed no changed files", () => {
    const env = { ...process.env, DOTBABEL_ATTEST_CHANGED_FILES: "", DOTBABEL_ATTEST_SKIP_FILE: "" };
    const r = node("dotbabel-attest-scope.mjs", ["--runner", "go", "--", process.execPath, "-e", "process.exit(7)"], {
      env,
    });
    expect(r.status).toBe(7);
    expect(r.stderr).toMatch(/runs the CI command in full/);
  });
});

describe("dotbabel local-attest --init (process level)", () => {
  it("drafts recognised test steps as scoped legs and leaves the rest alone", () => {
    const repo = makeTempDir("attest-scope-init-");
    mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(
      path.join(repo, ".github/workflows/test.yml"),
      [
        "name: test",
        "on: [pull_request]",
        "jobs:",
        "  web:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm ci",
        "      - run: npm test",
        "  api:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: go test -race ./...",
        "",
      ].join("\n"),
    );

    const r = node("dotbabel-local-attest.mjs", ["--init"], { cwd: repo });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/2 test leg\(s\) scoped/);

    const config = readFileSync(path.join(repo, ".local-attest.config.mjs"), "utf8");
    expect(config).toContain('command: "dotbabel attest-scope --runner vitest -- npm test",');
    expect(config).toContain('command: "dotbabel attest-scope --runner go -- go test -race ./...",');
    expect(config).toContain('command: "npm ci",');
    expect(config.match(/scope: true,/g)).toHaveLength(2);
  });
});
