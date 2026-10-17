import { expect, it } from "vitest";
import { orderQueue, reserveQueue, RESERVATION_MS } from "../src/fleet/merge-queue.mjs";
const now = Date.parse("2026-10-16T12:00:00Z");
const entry = (key, joined = 0, reservedUntil = null) => ({ owner: { key }, branch: key, joinedAt: new Date(now + joined).toISOString(), reservedUntil });
const task = (slug, branch, depends_on = [], status = "open") => ({ slug, branch, depends_on, status });

it("orders transitive dependencies through tasks with no queued session, then arrival", () => {
  const entries = [entry("b"), entry("c", 2), entry("a", 1)];
  const tasks = [task("a", "a"), task("middle", "middle", ["a"]), task("b", "b", ["middle"]), task("c", "c")];
  expect(orderQueue(entries, tasks).map((e) => e.branch)).toEqual(["a", "b", "c"]);
  expect(entries.map((e) => e.branch)).toEqual(["b", "c", "a"]);
});
it("closed and missing dependencies impose no ordering, and cycles preserve arrival", () => {
  const entries = [entry("a", 1), entry("b", 0)];
  expect(orderQueue(entries).map((e) => e.branch)).toEqual(["b", "a"]);
  expect(orderQueue(entries, [task("a", "a", [], "closed"), task("b", "b", ["a"])]).map((e) => e.branch)).toEqual(["b", "a"]);
  expect(orderQueue(entries, [task("a", "a"), task("middle", "middle", ["a"], "closed"), task("b", "b", ["middle", "missing"])]).map((e) => e.branch)).toEqual(["b", "a"]);
  expect(orderQueue(entries, [task("a", "a", ["b"]), task("b", "b", ["a"])]).map((e) => e.branch)).toEqual(["b", "a"]);
});
it("a live head keeps its reservation when a later dependency joins", () => {
  const head = entry("b", 0, new Date(now + 1000).toISOString());
  const result = reserveQueue([head, entry("a", 1)], { now, held: false, isAlive: () => true, tasks: [task("b", "b", ["a"]), task("a", "a")] });
  expect(result.map((e) => e.branch)).toEqual(["b", "a"]);
  expect(result[0].reservedUntil).toBe(head.reservedUntil);
  expect(result[1].reservedUntil).toBeNull();
  const held = reserveQueue(result, { now, held: true, isAlive: () => true });
  expect(held.every((e) => e.reservedUntil === null)).toBe(true);
});
it("drops malformed, dead, and expired entries and reserves exactly the next head", () => {
  const entries = [null, {}, { ...entry("bad"), owner: null }, { ...entry("bad-date"), joinedAt: "invalid" }, entry("dead"), entry("expired", 0, new Date(now).toISOString()), entry("live"), entry("last", 1)];
  const result = reserveQueue(entries, { now, held: false, isAlive: (o) => o.key !== "dead" });
  expect(result.map((e) => e.branch)).toEqual(["live", "last"]);
  expect(result[0].reservedUntil).toBe(new Date(now + RESERVATION_MS).toISOString());
  expect(result[1].reservedUntil).toBeNull();
});
