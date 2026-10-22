import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
const launcher = path.join(repo, "skills/yolo/scripts/codex-yolo.mjs");
const skillSelection = `\n\nRead and follow the yolo skill at ${JSON.stringify(path.join(repo, "skills/yolo/SKILL.md"))}.`;

function fixture() {
  const root = makeTempDir("codex-yolo-");
  const capture = path.join(root, "invocation.json");
  const config = path.join(root, "config.toml");
  fs.writeFileSync(config, 'approval_policy = "on-request"\n');
  fs.writeFileSync(
    path.join(root, "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.YOLO_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.YOLO_SIGNAL) process.kill(process.pid, process.env.YOLO_SIGNAL);
else process.exit(Number(process.env.YOLO_EXIT ?? 0));
`,
    { mode: 0o755 },
  );
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: root, CODEX_HOME: root, YOLO_CAPTURE: capture, ...env },
    });
    if (result.error) throw result.error;
    return result;
  };
  return { root, capture, config, run };
}

describe("Codex yolo launcher", () => {
  it.each(["1m", "24h", "1440m"])(
    "starts Full access for %s without changing configuration",
    (duration) => {
      const { root, capture, config, run } = fixture();
      const result = run(["--for", duration, "test, deploy, and release this project"]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
        argv: [
          "--sandbox",
          "danger-full-access",
          "--ask-for-approval",
          "never",
          `$yolo --for ${duration} test, deploy, and release this project${skillSelection}`,
        ],
        cwd: root,
      });
      expect(fs.readFileSync(config, "utf8")).toBe('approval_policy = "on-request"\n');
    },
  );

  it.each(["--merge", "--no-merge"])("preserves the explicit %s restriction", (flag) => {
    const { capture, run } = fixture();
    expect(run(["ship the project", flag, "--for", "12h"]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, "utf8")).argv.at(-1)).toBe(
      `$yolo --for 12h ${flag} ship the project${skillSelection}`,
    );
  });

  it("passes shell syntax as literal prompt text", () => {
    const { root, capture, run } = fixture();
    const scope = 'test $(touch injected) `touch injected` ; "release"';
    expect(run(["--for", "1h", scope]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, "utf8")).argv.at(-1)).toBe(
      `$yolo --for 1h ${scope}${skillSelection}`,
    );
    expect(fs.existsSync(path.join(root, "injected"))).toBe(false);
  });

  it.each([
    [],
    ["--for"],
    ["--for", "1h"],
    ["ship"],
    ["off"],
    ["--for", "0h", "ship"],
    ["--for", "25h", "ship"],
    ["--for", "1441m", "ship"],
    ["--for", "-1h", "ship"],
    ["--for", "1.5h", "ship"],
    ["--for", "1h", "--for", "2h", "ship"],
    ["--for", "1h", "--merge", "--no-merge", "ship"],
    ["--for", "1h", "--unknown", "ship"],
  ])("rejects invalid activation %j before starting Codex", (...args) => {
    const { capture, run } = fixture();
    const result = run(args);
    expect(result.status, result.stderr).toBe(64);
    expect(result.stderr).toContain("Usage:");
    expect(fs.existsSync(capture)).toBe(false);
  });

  it("prints help without starting Codex", () => {
    const { capture, run } = fixture();
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Full access");
    expect(fs.existsSync(capture)).toBe(false);
  });

  it("reports a missing Codex executable", () => {
    const { root, run } = fixture();
    fs.unlinkSync(path.join(root, "codex"));
    const result = run(["--for", "1h", "ship"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("codex");
  });

  it("preserves the Codex exit code", () => {
    const { run } = fixture();
    expect(run(["--for", "1h", "ship"], { YOLO_EXIT: "7" }).status).toBe(7);
  });

  it("reports a terminated Codex process as failure", () => {
    const { run } = fixture();
    expect(run(["--for", "1h", "ship"], { YOLO_SIGNAL: "SIGTERM" }).status).toBe(143);
  });
});
