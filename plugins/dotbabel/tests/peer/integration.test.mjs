import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { createNativeIntegration } from "../../src/peer/integration.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import { repository } from "../../src/peer/identity.mjs";
import { readNativeRegistration } from "../../src/peer/native-registry.mjs";
const hosts = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});
async function fixture() {
  const root = makeTempDir("peer-integration-"),
    worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const env = { DOTBABEL_PEER_STATE_DIR: path.join(root, "state"), DOTBABEL_PEER_NO_RELAY: "1" };
  const host = createNativeIntegration({
    harness: "opencode",
    worktree,
    env,
    notify: async () => {},
  });
  hosts.push(host);
  const pair = await host.invoke("ses_main", ["main"]);
  await host.invoke("ses_advisor", ["advisor", pair.code]);
  return { host, pair };
}
it("keeps unpaired sessions unchanged and denies Advisor writes without granting Main permissions", async () => {
  const { host } = await fixture();
  const write = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} };
  expect(await host.hook("ses_other", write)).toBeNull();
  expect(await host.hook("ses_main", write)).toBeNull();
  expect((await host.hook("ses_advisor", write)).hookSpecificOutput.permissionDecision).toBe(
    "deny",
  );
  expect(
    await host.hook("ses_advisor", {
      ...write,
      tool_name: "Bash",
      tool_input: { command: "git status" },
    }),
  ).toBeNull();
  expect(
    (
      await host.hook("ses_advisor", {
        ...write,
        tool_name: "Bash",
        tool_input: { command: "git status; touch stolen" },
      })
    ).hookSpecificOutput.permissionDecision,
  ).toBe("deny");
});
it("recovers role context while using the same domain operations and real session key", async () => {
  const { host, pair } = await fixture();
  expect(await host.context("ses_advisor")).toContain("Advisor");
  expect(await host.context("ses_advisor")).toContain(pair.id);
  expect(await host.context("ses_main")).toContain("Main");
  expect(await host.context("ses_other")).toBeNull();
  await host.invoke("ses_main", ["unpair"]);
  expect(await host.context("ses_advisor")).toBeNull();
});
it("requests one continuation for unfinished work, then pauses rather than looping", async () => {
  const { host } = await fixture();
  await host.invoke("ses_main", ["ask", "Inspect"]);
  const task = await host.invoke("ses_advisor", ["next"]);
  expect(await host.idle("ses_advisor")).toContain(task.id);
  expect(await host.idle("ses_advisor")).toBeNull();
  expect((await host.invoke("ses_advisor", ["status"])).paused).toBe(true);
});
it("does not treat an idle event as completed or processed", async () => {
  const { host } = await fixture();
  const request = await host.invoke("ses_main", ["ask", "Inspect"]);
  await host.idle("ses_advisor");
  expect((await host.invoke("ses_advisor", ["queue"]))[0]).toMatchObject({
    id: request.id,
    state: "running",
    result: null,
  });
});
it("allows one reminder for each new request lease rather than pausing the next investigation", async () => {
  const { host } = await fixture();
  await host.invoke("ses_main", ["ask", "First"]);
  const first = await host.invoke("ses_advisor", ["next"]);
  await host.idle("ses_advisor");
  await host.invoke("ses_advisor", [
    "complete",
    first.id,
    "--lease",
    first.lease,
    "--result",
    "Done",
  ]);
  await host.invoke("ses_main", ["ask", "Second"]);
  const second = await host.invoke("ses_advisor", ["next"]);
  expect(await host.idle("ses_advisor")).toContain(second.id);
  expect((await host.invoke("ses_advisor", ["status"])).paused).toBe(false);
});
it("rejects setup and cross-repository flags through the native tool", async () => {
  const { host } = await fixture();
  await expect(host.invoke("ses_main", ["setup", "--harness", "both"])).rejects.toThrow();
  await expect(host.invoke("ses_main", ["main", "--repo-root", "/tmp"])).rejects.toThrow();
});
it("closes a newly opened endpoint when role restoration fails", async () => {
  const root = makeTempDir("peer-native-rollback-"),
    worktree = path.join(root, "repo"),
    stateRoot = path.join(root, "state");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const store = new PeerStore(stateRoot, repository(worktree).key);
  await store.transaction(() => {});
  fs.writeFileSync(store.file, "broken");
  const host = createNativeIntegration({
    harness: "opencode",
    worktree,
    env: { DOTBABEL_PEER_STATE_DIR: stateRoot },
    notify: async () => {},
  });
  hosts.push(host);
  await expect(host.invoke("ses_failed", ["main"])).rejects.toThrow();
  expect(readNativeRegistration(stateRoot, "opencode:ses_failed")).toBeNull();
});
