import { it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import {
  registerMain,
  pairAdvisor,
  enqueue,
  finishRequest,
  sendMessage,
} from "../../src/peer/state.mjs";
import { tick } from "../../src/peer/relay.mjs";
import { processState } from "../../src/fleet/registry.mjs";
const main = { harness: "claude", sessionId: "main", key: "claude:main", repo: "repo" },
  advisor = { harness: "codex", sessionId: "adv", key: "codex:adv", repo: "repo" };
async function world() {
  const store = new PeerStore(makeTempDir("peer-relay-"), "repo");
  let id;
  await store.transaction((s) => {
    const p = registerMain(s, main, { alive: () => true });
    id = p.id;
    pairAdvisor(s, advisor, p.code, { alive: () => true });
    enqueue(p, "one");
    enqueue(p, "two");
  });
  return { store, id };
}
it("dispatches once, accepts new work during execution and advances after explicit completion", async () => {
  const { store, id } = await world(),
    calls = [];
  const opts = {
    alive: () => true,
    transport: async (w, text) => {
      calls.push([w.key, text]);
      return { state: "transport_accepted" };
    },
  };
  await tick(store, id, opts);
  await tick(store, id, opts);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(advisor.key);
  await store.transaction((s) => {
    const p = s.pairs[0],
      r = p.requests[0];
    enqueue(p, "while busy");
    finishRequest(p, advisor, r.id, r.lease, "completed", "done");
    sendMessage(p, advisor, "main", "finding");
  });
  await tick(store, id, opts);
  expect(calls).toHaveLength(3);
  const p = (await store.read()).pairs[0];
  expect(p.requests.map((r) => r.state)).toEqual(["completed", "running", "queued"]);
  expect(p.messages[0].delivery.state).toBe("transport_accepted");
});
it("records uncertain crash windows without automatically duplicating delivery", async () => {
  const { store, id } = await world();
  let calls = 0;
  await tick(store, id, {
    alive: () => true,
    transport: async () => {
      calls++;
      throw new Error("crash");
    },
  });
  await tick(store, id, {
    alive: () => true,
    transport: async () => {
      calls++;
      return { state: "transport_accepted" };
    },
  });
  expect(calls).toBe(1);
  expect((await store.read()).pairs[0].requests[0].dispatch.state).toBe("uncertain");
});
it("does not dispatch to dead peers or start new work while paused", async () => {
  const { store, id } = await world();
  await tick(store, id, {
    alive: () => false,
    transport: () => {
      throw new Error("must not run");
    },
  });
  expect((await store.read()).pairs[0].requests[0].state).toBe("queued");
  await store.transaction((s) => {
    s.pairs[0].paused = true;
  });
  await tick(store, id, {
    alive: () => true,
    transport: () => {
      throw new Error("must not run");
    },
  });
  expect((await store.read()).pairs[0].requests[0].state).toBe("queued");
});
it("bounds retries with backoff and recovers an interrupted request after an Advisor restart", async () => {
  const { store, id } = await world();
  let count = 0;
  for (let n = 0; n < 5; n++)
    await tick(store, id, {
      now: 100000 + n * 60000,
      alive: () => true,
      transport: async () => {
        count++;
        return { state: "failed", retryable: true, error: "offline" };
      },
    });
  expect(count).toBe(3);
  expect((await store.read()).pairs[0].requests[0].dispatch.state).toBe("failed");
});

it("re-dispatches a waiting request after its correlated reply with a new lease", async () => {
  const { store, id } = await world(),
    calls = [];
  const opts = {
    alive: () => true,
    transport: async (w, text) => {
      calls.push(w.key);
      return { state: "transport_accepted" };
    },
  };
  await tick(store, id, opts);
  let old;
  await store.transaction((s) => {
    const p = s.pairs[0],
      r = p.requests[0];
    old = r.lease;
    const q = sendMessage(p, advisor, "main", "question", { kind: "question", requestId: r.id });
    finishRequest(p, advisor, r.id, r.lease, "waiting_for_peer", "wait", q.id);
    p.requests[1].state = "cancelled";
    sendMessage(p, main, "advisor", "answer", { kind: "reply", replyTo: q.id });
  });
  await tick(store, id, opts);
  const r = (await store.read()).pairs[0].requests[0];
  expect(r.state).toBe("running");
  expect(r.lease).not.toBe(old);
  expect(r.dispatch.state).toBe("transport_accepted");
  expect(calls.filter((x) => x === advisor.key).length).toBeGreaterThan(1);
});

async function messages(bodies) {
  const { store, id } = await world();
  await store.transaction((s) => {
    const p = s.pairs[0];
    p.paused = true;
    for (const body of bodies) sendMessage(p, advisor, "main", body);
  });
  const calls = [];
  const opts = {
    alive: () => true,
    transport: async (w) => {
      calls.push(w.key);
      return { state: "transport_accepted" };
    },
  };
  return { store, id, calls, opts };
}
it("pushes a new message although an older pushed message is still unread", async () => {
  const { store, id, calls, opts } = await messages(["first"]);
  await tick(store, id, opts);
  expect(calls).toEqual([main.key]);
  await store.transaction((s) => {
    const p = s.pairs[0];
    sendMessage(p, advisor, "main", "second");
    sendMessage(p, advisor, "main", "third");
    p.messages[0].delivery.state = "uncertain";
  });
  await tick(store, id, opts);
  await tick(store, id, opts);
  await tick(store, id, opts);
  expect(calls).toEqual([main.key, main.key, main.key]);
  const p = (await store.read()).pairs[0];
  expect(p.messages.map((m) => m.delivery.state)).toEqual([
    "uncertain",
    "transport_accepted",
    "transport_accepted",
  ]);
  expect(p.messages[0].delivery.attempts).toBe(1);
});
it("keeps order behind a push in flight or a retry in backoff", async () => {
  const { store, id, calls, opts } = await messages(["first", "second"]);
  await store.transaction((s) => {
    s.pairs[0].messages[0].delivery = {
      state: "sending",
      attempts: 1,
      nextAt: 0,
      sender: { pid: process.pid, procStart: processState(process.pid).startTime },
    };
  });
  await tick(store, id, opts);
  expect(calls).toEqual([]);
  await store.transaction((s) => {
    s.pairs[0].messages[0].delivery = {
      state: "persisted",
      attempts: 1,
      nextAt: Date.now() + 60000,
    };
  });
  await tick(store, id, opts);
  expect(calls).toEqual([]);
  expect((await store.read()).pairs[0].messages[1].delivery.state).toBe("persisted");
});
