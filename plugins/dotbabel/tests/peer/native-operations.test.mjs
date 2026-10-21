import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { openNativeEndpoint } from "../../src/peer/native.mjs";
import { invokePeer } from "../../src/peer/cli.mjs";
import { deliver } from "../../src/peer/transport.mjs";

const endpoints = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
async function fixture() {
  const root = makeTempDir("peer-native-ops-"),
    worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const env = { DOTBABEL_PEER_STATE_DIR: path.join(root, "state"), DOTBABEL_PEER_NO_RELAY: "1" };
  for (const [harness, sessionId] of [
    ["opencode", "ses_main_fixture"],
    ["copilot", "00000000-0000-4000-8000-000000000002"],
  ]) {
    endpoints.push(
      await openNativeEndpoint({ harness, sessionId, worktree, env, notify: async () => {} }),
    );
  }
  const [main, advisor] = endpoints.slice(-2);
  return { main: main.who, advisor: advisor.who, env };
}
it("uses the real domain lifecycle from two native integration actors", async () => {
  const { main, advisor, env } = await fixture();
  const run = (who, argv) => invokePeer(who, argv, env);
  const pair = await run(main, ["main"]);
  await run(advisor, ["advisor", pair.code]);
  const request = await run(main, ["ask", "Investigate", "--dedupe", "native-case"]);
  const claimed = await run(advisor, ["next"]);
  expect(claimed.id).toBe(request.id);
  const finding = await run(advisor, [
    "send",
    "main",
    "Actionable evidence",
    "--kind",
    "finding",
    "--request",
    request.id,
  ]);
  expect((await run(main, ["receive"]))[0].id).toBe(finding.id);
  await run(main, ["ack", finding.id, "--processed"]);
  const reply = await run(main, [
    "send",
    "advisor",
    "Reasoned response",
    "--kind",
    "reply",
    "--reply-to",
    finding.id,
  ]);
  await run(advisor, ["receive"]);
  await run(advisor, ["ack", reply.id, "--processed"]);
  await run(advisor, ["complete", request.id, "--lease", claimed.lease, "--result", "Done"]);
  expect((await run(main, ["queue"]))[0].state).toBe("completed");
  expect(await run(main, ["unpair"])).toMatchObject({ closed: true });
  const again = await run(main, ["main"]);
  await run(advisor, ["advisor", again.code]);
  expect(await run(main, ["unpair"])).toEqual({ id: again.id, closed: true });
});
it("keeps native integration tools scoped to their verified session and repository", async () => {
  const { main, advisor, env } = await fixture();
  await expect(invokePeer(main, ["setup", "--harness", "both"], env)).rejects.toThrow(
    /integration|operation/,
  );
  await expect(invokePeer(main, ["hook", "SessionStart"], env)).rejects.toThrow(
    /integration|operation/,
  );
  await expect(invokePeer(main, ["main", "--repo-root", "/tmp"], env)).rejects.toThrow(
    /repository|integration/,
  );
  await expect(invokePeer(main, "main", env)).rejects.toThrow(/arguments/);
  await expect(invokePeer({ ...main, sessionId: "ses_forged" }, ["main"], env)).rejects.toThrow(
    /registered|identity/,
  );
  const pair = await invokePeer(main, ["main"], env);
  await expect(invokePeer(advisor, ["status", "--pair", pair.id], env)).rejects.toThrow(/member/);
});
it("routes native harnesses through the real endpoint rather than an unknown-harness fallback", async () => {
  const { main } = await fixture();
  expect((await deliver(main, "native notification")).state).toBe("transport_accepted");
  expect(await deliver({ ...main, nativeProtocol: undefined }, "wake")).toMatchObject({
    state: "failed",
    retryable: false,
  });
});
it("exposes native operation help without granting setup, launch, or actor overrides", async () => {
  const { main, env } = await fixture();
  expect((await invokePeer(main, ["--help"], env)).usage).toContain("--result TEXT");
  await expect(
    invokePeer(main, ["launch", "main", "--harness", "antigravity"], env),
  ).rejects.toThrow(/operation/);
  await expect(invokePeer(main, ["--help", "--repo-root", "/tmp"], env)).rejects.toThrow(
    /integration/,
  );
});
