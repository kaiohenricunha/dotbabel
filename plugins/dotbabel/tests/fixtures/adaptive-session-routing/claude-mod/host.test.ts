import { test, expect } from "claude-code/testing";

const consume = async stream => {
  let item = await stream.next();
  while (!item.done) item = await stream.next();
  return item.value;
};

test("production MAIN boundary relays one native stream", async ($, on) => {
  on("session.root", () => ({ value: "/project" }));
  on("ui.log", () => ({ value: {} }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  let calls = 0;
  let received;
  on("turn.step", async function* ($, e) {
    calls++;
    received = e;
    return { turnId: e.turnId, index: e.index, answer: "native", toolUses: [], stopReason: "end_turn", usage: null };
  });
  await $.turn.start({ turnId: "one", text: "Implement integration tests." });
  await consume($.turn.step({ turnId: "one", index: 0, model: "original", effort: "low", messageCount: 4 }));
  expect(calls).toBe(1);
  expect(received.model).toBe("host-selected");
  expect(received.effort).toBe("high");
  expect(received.messageCount).toBe(4);
});
