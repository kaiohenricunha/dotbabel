import { describe, it, expect } from "vitest";
import {
  createState,
  registerMain,
  pairAdvisor,
  enqueue,
  nextRequest,
  finishRequest,
  sendMessage,
  receiveMessages,
  acknowledge,
  changeRequest,
  reconnect,
  unpair,
} from "../../src/peer/state.mjs";
const endpoint = (harness, id) => ({
  harness,
  sessionId: id,
  key: `${harness}:${id}`,
  pid: 1,
  procStart: "1",
  worktree: "/repo",
  repo: "repo",
});
const alive = () => true;
function world(a = "claude", b = "codex") {
  const s = createState("repo"),
    main = endpoint(a, "main"),
    advisor = endpoint(b, "advisor");
  const p = registerMain(s, main, { now: 1000, alive });
  pairAdvisor(s, advisor, p.code, { now: 1001, alive });
  return { s, p, main, advisor };
}
describe("pairing", () => {
  for (const a of ["claude", "codex"])
    for (const b of ["claude", "codex"])
      it(`${a} Main and ${b} Advisor`, () => {
        const { s, p, main, advisor } = world(a, b);
        expect(p.main.key).toBe(main.key);
        expect(p.advisor.key).toBe(advisor.key);
        expect(registerMain(s, main, { now: 1002, alive }).id).toBe(p.id);
        expect(() => pairAdvisor(s, endpoint(b, "other"), p.code, { now: 1003, alive })).toThrow(
          /occupied/,
        );
      });
  it("rejects foreign repositories, expired codes and stale mains", () => {
    const { s, p } = world();
    expect(() =>
      registerMain(s, { ...endpoint("claude", "x"), repo: "foreign" }, { alive }),
    ).toThrow(/repository/);
    p.advisor = null;
    expect(() =>
      pairAdvisor(s, endpoint("codex", "x"), p.code, { now: p.codeExpiresAt + 1, alive }),
    ).toThrow(/expired/);
    expect(() =>
      pairAdvisor(s, endpoint("codex", "x"), p.code, { now: 1002, alive: () => false }),
    ).toThrow(/unavailable/);
  });
  it("requires selection for ambiguous discovery", () => {
    const s = createState("repo");
    registerMain(s, endpoint("claude", "a"), { now: 1, alive });
    registerMain(s, endpoint("codex", "b"), { now: 1, alive });
    expect(() => pairAdvisor(s, endpoint("codex", "c"), null, { now: 2, alive })).toThrow(
      /ambiguous/,
    );
  });
  it("discovers a unique main and reconnects only a terminated role", () => {
    const s = createState("repo"),
      main = endpoint("claude", "a"),
      advisor = endpoint("codex", "b");
    const p = registerMain(s, main, { now: 1, alive });
    pairAdvisor(s, advisor, null, { now: 2, alive });
    expect(() => reconnect(s, p.id, "advisor", endpoint("codex", "c"), { alive })).toThrow(/alive/);
    reconnect(s, p.id, "advisor", endpoint("codex", "c"), { alive: () => false });
    expect(p.advisor.sessionId).toBe("c");
    unpair(s, p.id, main);
    expect(p.closed).toBe(true);
    expect(() => enqueue(p, "later")).toThrow(/closed/);
  });
});
describe("durable investigations", () => {
  it("runs FIFO with one active request and advances after completion", () => {
    const { p, advisor } = world();
    const a = enqueue(p, "one"),
      b = enqueue(p, "two");
    expect(nextRequest(p, advisor).id).toBe(a.id);
    expect(nextRequest(p, advisor).id).toBe(a.id);
    const c = enqueue(p, "while busy");
    finishRequest(p, advisor, a.id, a.lease, "completed", "result");
    expect(a.result).toBe("result");
    expect(nextRequest(p, advisor).id).toBe(b.id);
    expect(c.state).toBe("queued");
  });
  it("supports waiting, correlated replies and independent investigations", () => {
    const { p, main, advisor } = world();
    const a = enqueue(p, "one"),
      b = enqueue(p, "two");
    nextRequest(p, advisor);
    const question = sendMessage(p, advisor, "main", "why?", { kind: "question", requestId: a.id });
    finishRequest(p, advisor, a.id, a.lease, "waiting_for_peer", "waiting", question.id);
    expect(nextRequest(p, advisor).id).toBe(b.id);
    sendMessage(p, main, "advisor", "because", { kind: "reply", replyTo: question.id });
    expect(a.state).toBe("queued");
    expect(b.state).toBe("running");
  });
  it("cancels, reprioritizes and rejects stale completion leases", () => {
    const { p, advisor } = world();
    const a = enqueue(p, "a"),
      b = enqueue(p, "b");
    changeRequest(p, b.id, "priority", 9);
    expect(nextRequest(p, advisor).id).toBe(b.id);
    const lease = b.lease;
    changeRequest(p, b.id, "cancel");
    expect(() => finishRequest(p, advisor, b.id, lease, "completed", "late")).toThrow(/running/);
    expect(nextRequest(p, advisor).id).toBe(a.id);
    expect(() => finishRequest(p, advisor, a.id, "wrong", "completed", "x")).toThrow(/lease/);
  });
  it("deduplicates requests and validates follow-up and input boundaries", () => {
    const { p } = world();
    const a = enqueue(p, "a", { dedupe: "once" });
    expect(enqueue(p, "a", { dedupe: "once" }).id).toBe(a.id);
    expect(() => enqueue(p, "other", { dedupe: "once" })).toThrow(/different/);
    expect(enqueue(p, "follow", { parentId: a.id }).parent_id).toBe(a.id);
    expect(() => enqueue(p, "follow", { parentId: "missing" })).toThrow(/request/);
    for (const body of ["", "x".repeat(16385), null]) expect(() => enqueue(p, body)).toThrow();
  });
});
describe("messaging", () => {
  it("routes both ways with separate delivered, processed and acknowledged states", () => {
    const { p, main, advisor } = world();
    const a = sendMessage(p, advisor, "main", "finding", { kind: "finding", dedupe: "one" });
    expect(sendMessage(p, advisor, "main", "finding", { kind: "finding", dedupe: "one" }).id).toBe(
      a.id,
    );
    expect(a.delivery.state).toBe("persisted");
    expect(receiveMessages(p, main).map((x) => x.id)).toEqual([a.id]);
    expect(a.delivery.state).toBe("delivered");
    acknowledge(p, main, a.id, "processed");
    expect(a.delivery.state).toBe("processed");
    const b = sendMessage(p, main, "advisor", "reply", { kind: "reply", replyTo: a.id });
    expect(b.reply_to).toBe(a.id);
    expect(receiveMessages(p, advisor)[0].id).toBe(b.id);
    acknowledge(p, main, a.id);
    expect(a.delivery.state).toBe("acknowledged");
  });
  it("rejects unauthorized recipients, bad correlations, reply loops and invalid kinds", () => {
    const { p, main, advisor } = world();
    expect(() => sendMessage(p, endpoint("claude", "foreign"), "main", "x")).toThrow(/member/);
    expect(() => sendMessage(p, advisor, "advisor", "x")).toThrow(/recipient/);
    expect(() => sendMessage(p, main, "advisor", "x", { kind: "bad" })).toThrow(/kind/);
    expect(() => sendMessage(p, main, "advisor", "x", { replyTo: "missing" })).toThrow(/reply/);
    let m = sendMessage(p, main, "advisor", "question");
    for (let n = 0; n < 6; n++) {
      const who = n % 2 ? main : advisor;
      m = sendMessage(p, who, n % 2 ? "advisor" : "main", "reply", { replyTo: m.id });
    }
    expect(() => sendMessage(p, advisor, "main", "loop", { replyTo: m.id })).toThrow(/depth/);
  });
});

it("preserves reply correlation when an Advisor sender is replaced after termination", () => {
  const { s, p, main, advisor } = world(),
    finding = sendMessage(p, advisor, "main", "finding");
  const replacement = endpoint("codex", "replacement");
  reconnect(s, p.id, "advisor", replacement, { alive: () => false });
  const response = sendMessage(p, main, "advisor", "answer", {
    kind: "reply",
    replyTo: finding.id,
  });
  expect(response.to).toBe(replacement.key);
  expect(response.reply_to).toBe(finding.id);
});
