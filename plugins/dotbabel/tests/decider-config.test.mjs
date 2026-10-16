import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { deciderContext, describeDecider, decisionAttemptCap } from "../src/decider-config.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

function repository(config) {
  const root = makeTempDir("decider-config-");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".dotbabel.json"), JSON.stringify(config));
  git("add", ".dotbabel.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "config");
  return { root, git, write: (value) => fs.writeFileSync(path.join(root, ".dotbabel.json"), typeof value === "string" ? value : JSON.stringify(value)) };
}
it("reads committed consent per step and reports only key presence", () => {
  const { root, write } = repository({ decider: { adapter: "jev", steps: ["retry"] } });
  write({ decider: { adapter: "jev", steps: ["retry", "dispatch"] } });
  const context = deciderContext(root, { TYPESAFE_API_KEY: "canary-context" });
  expect(context.consentSteps).toEqual(["retry"]);
  expect(describeDecider(context)).toContain("key present");
  expect(describeDecider(context)).not.toContain("canary-context");
});
it("missing config or committed consent defaults to offline built-in rules", () => {
  const { root, write } = repository({});
  write({ decider: { adapter: "jev", steps: ["retry"] } });
  expect(deciderContext(root, {}).consentSteps).toEqual([]);
  fs.unlinkSync(path.join(root, ".dotbabel.json"));
  expect(deciderContext(root, {}).config.adapter).toBe("builtin");
  expect(describeDecider(deciderContext(root, {}))).toContain("key absent");
});
it("invalid configurations and unknown fields never provide consent", () => {
  const { root, write } = repository({});
  for (const value of ["{", "null", "[]", "42", '"text"', { decider: {} }, { decider: [] }, { decider: { adapter: "unknown", steps: [] } }, { decider: { adapter: "jev", steps: ["unknown"] } }, { decider: { adapter: "jev", steps: ["retry", "unknown"] } }, { decider: { adapter: "jev", steps: [], key: "forbidden" } }, { decider: { adapter: "jev", steps: ["retry", "retry"] } }]) {
    write(value);
    expect(() => deciderContext(root, {})).toThrow();
  }
  expect(() => deciderContext(makeTempDir("no-repo-"), {})).toThrow(/repository/);
});
it("default retry selection uses a fetched remote base before a branch's raised cap", () => {
  for (const symbolic of [false, true]) {
    const { root, git, write } = repository({ conductor: { max_attempts: 2 } });
    const sha = git("rev-parse", "HEAD").trim();
    git("update-ref", "refs/remotes/origin/main", sha);
    if (symbolic) git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    write({ conductor: { max_attempts: 10 } }); git("add", ".dotbabel.json"); git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "raise");
    expect(decisionAttemptCap(root, "review-pr")).toBe(2);
  }
});
it("uncommitted consent is not inferred from a missing or malformed committed config", () => {
  const { root, git, write } = repository({});
  write("{"); git("add", ".dotbabel.json"); git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "bad config");
  expect(() => decisionAttemptCap(root, "review-pr", "HEAD")).toThrow(/invalid/);
  write({ decider: { adapter: "jev", steps: ["retry"] } });
  expect(deciderContext(root, {}).consentSteps).toEqual([]);
});
it("the retry cap uses the named base and refuses missing or damaged bases", () => {
  const { root, git, write } = repository({ conductor: { max_attempts: 2 } });
  git("branch", "base");
  write({ conductor: { max_attempts: 10 } });
  expect(decisionAttemptCap(root, "review-pr", "base")).toBe(2);
  expect(() => decisionAttemptCap(root, "review-pr", "missing")).toThrow();
  expect(() => decisionAttemptCap(root, "unknown", "base")).toThrow();
  write({ conductor: { max_attempts: 0 } }); git("add", ".dotbabel.json"); git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "invalid cap");
  expect(() => decisionAttemptCap(root, "review-pr", "HEAD")).toThrow();
});
