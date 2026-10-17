import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
const bin = path.resolve(import.meta.dirname, "../bin/dotbabel-decide.mjs");
function repo(config = {}) {
  const cwd = makeTempDir("decider-cli-");
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, ".dotbabel.json"), JSON.stringify(config));
  execFileSync("git", ["add", ".dotbabel.json"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "config"], { cwd });
  return cwd;
}
const run = (cwd, step, input, env = {}) => spawnSync(process.execPath, [bin, "--step", step], { cwd, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
it("decide preserves UTF-8 characters split between real pipe chunks", async () => {
  const cwd = repo({ decider: { adapter: "jev", steps: ["review-triage"] } });
  const fixture = path.join(cwd, "fetch-fixture.mjs");
  const capture = path.join(cwd, "request.json");
  fs.writeFileSync(fixture, `import fs from "node:fs";
globalThis.fetch = async (_, options) => {
  fs.writeFileSync(process.env.CAPTURE_REQUEST_FILE, options.body);
  return new Response(JSON.stringify({answers:{real_defect:{noul:0.95}}}), {status:200});
};
const iterate = process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator] = async function* () {
  process.stderr.write("fixture-ready\\n");
  for await (const chunk of { [Symbol.asyncIterator]: iterate }) {
    yield chunk;
    process.stderr.write("fixture-consumed\\n");
  }
};
`);
  const finding = { file: "a.mjs", title: "Ação", body: "ação", diff_hunk: "+ true", severity: "important", category: "bug" };
  const input = Buffer.from(JSON.stringify({ finding }));
  const split = input.indexOf(Buffer.from("ã")) + 1;
  const child = spawn(process.execPath, ["--import", fixture, bin, "--step", "review-triage"], { cwd, env: { ...process.env, TYPESAFE_API_KEY: "utf8-canary", CAPTURE_REQUEST_FILE: capture } });
  let stdout = "", stderr = "", first = false, second = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (!first && stderr.includes("fixture-ready\n")) { first = true; child.stdin.write(input.subarray(0, split)); }
    if (!second && stderr.includes("fixture-consumed\n")) { second = true; child.stdin.end(input.subarray(split)); }
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect(code).toBe(0);
  expect(JSON.parse(stdout).shadow.answer).toBe("auto-valid");
  expect(JSON.parse(JSON.parse(fs.readFileSync(capture, "utf8")).state)).toEqual({ finding });
});
it("decide exits 64 on an unknown step", () => {
  expect(run(repo(), "bad", {}).status).toBe(64);
});
it("the CLI returns JSON with the built-in answer", () => {
  const out = run(repo(), "retry", { phase: "review-pr", attempt: 1, failure_tail: "error" });
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout)).toMatchObject({ step: "retry", answer: "fix", fallback: false });
});
it("malformed JSON, unreadable config, and no repository have distinct exits", () => {
  const cwd = repo();
  expect(run(cwd, "retry", {}).status).toBe(64);
  expect(spawnSync(process.execPath, [bin, "--step", "retry"], { cwd, input: "{", encoding: "utf8" }).status).toBe(64);
  fs.writeFileSync(path.join(cwd, ".dotbabel.json"), "{");
  expect(run(cwd, "retry", {}).status).toBe(2);
  expect(run(makeTempDir("not-git-"), "retry", {}).status).toBe(2);
});
it("retry uses the committed base cap even when the branch raises it", () => {
  const cwd = repo({ conductor: { max_attempts: 1 } });
  execFileSync("git", ["branch", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, ".dotbabel.json"), JSON.stringify({ conductor: { max_attempts: 10 } }));
  execFileSync("git", ["add", ".dotbabel.json"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "raise cap"], { cwd });
  const input = JSON.stringify({ phase: "review-pr", attempt: 1, failure_tail: "error" });
  const out = spawnSync(process.execPath, [bin, "--step", "retry", "--base-ref", "base"], { cwd, input, encoding: "utf8" });
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout).answer).toBe("ask-owner");
});
it("uncommitted repository consent and a missing key never start an adapter", () => {
  const cwd = repo();
  fs.writeFileSync(path.join(cwd, ".dotbabel.json"), JSON.stringify({ decider: { adapter: "jev", steps: ["retry"] } }));
  const out = run(cwd, "retry", { phase: "review-pr", attempt: 1, failure_tail: "error" }, { TYPESAFE_API_KEY: "canary-cli-123" });
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout)).toMatchObject({ fallback: true, shadow: null });
  expect(out.stdout + out.stderr).not.toContain("canary-cli-123");
});
