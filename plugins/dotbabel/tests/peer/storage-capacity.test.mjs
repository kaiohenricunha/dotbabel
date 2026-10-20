import fs from "node:fs";
import path from "node:path";
import { vi, it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import {
  createState,
  registerMain,
  pairAdvisor,
  enqueue,
  nextRequest,
  finishRequest,
  recoverRequests,
  changeRequest,
  unpair,
  sendMessage,
  acknowledge,
} from "../../src/peer/state.mjs";

const LIMIT = 32 * 1024 * 1024;
const main = { key: "main", repo: "repo" };
const advisor = { key: "advisor", repo: "repo" };
function fixture() {
  const store = new PeerStore(makeTempDir("peer-capacity-"), "repo");
  const state = createState("repo");
  const pair = registerMain(state, main, { alive: () => true });
  pairAdvisor(state, advisor, pair.code, { alive: () => true });
  return { store, state, pair };
}
function saveAtLimit(store, state, bytes = LIMIT) {
  state.padding = "";
  state.padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(state) + "\n"));
  const text = JSON.stringify(state) + "\n";
  expect(Buffer.byteLength(text)).toBe(bytes);
  fs.writeFileSync(store.file, text, { mode: 0o600 });
  return text;
}

it("recovers and cancels at the legacy repository byte limit", async () => {
  const { store, state, pair } = fixture();
  const running = enqueue(pair, "running"),
    queued = enqueue(pair, "queued");
  nextRequest(pair, advisor);
  saveAtLimit(store, state);
  await store.transaction((s) => recoverRequests(s.pairs[0], "Interrupt: explicit retry required"));
  await store.transaction((s) => changeRequest(s.pairs[0], queued.id, "cancel"));
  const actual = await new PeerStore(store.root, "repo").read();
  expect(actual.pairs[0].requests.find((r) => r.id === running.id)).toMatchObject({
    state: "queued",
    lease: null,
  });
  expect(actual.pairs[0].requests.find((r) => r.id === queued.id).state).toBe("cancelled");
});

it("reserves space before admission and refuses new work in legacy recovery space", async () => {
  const { store, state, pair } = fixture();
  enqueue(pair, "active");
  const original = saveAtLimit(store, state, LIMIT - 1024);
  await expect(store.transaction((s) => enqueue(s.pairs[0], "new"))).rejects.toThrow(
    /capacity.*archive/i,
  );
  expect(fs.readFileSync(store.file, "utf8")).toBe(original);
  await store.transaction((s) => {
    s.pairs[0].paused = true;
  });
  await expect(
    store.transaction((s) => registerMain(s, { ...main, key: "another" }, { alive: () => true })),
  ).rejects.toThrow(/capacity.*archive/i);
});

it("allows a maximum-size final result using capacity reserved at admission", async () => {
  const { store, state, pair } = fixture();
  const r = enqueue(pair, "work");
  nextRequest(pair, advisor);
  // Leave enough storage for the task's final result and control metadata.
  saveAtLimit(store, state, LIMIT - 240 * 1024);
  fs.unlinkSync(store.file);
  await store.transaction((s) => Object.assign(s, state));
  await store.transaction((s) =>
    finishRequest(s.pairs[0], advisor, r.id, r.lease, "completed", "\u0001".repeat(16384)),
  );
  expect((await store.read()).pairs[0].requests[0].result).toHaveLength(16384);
  expect(fs.statSync(store.file).size).toBeLessThanOrEqual(LIMIT);
});

it("preserves acknowledgment and closing at the legacy capacity boundary", async () => {
  const { store, state, pair } = fixture();
  const m = sendMessage(pair, main, "advisor", "message");
  saveAtLimit(store, state);
  await store.transaction((s) => acknowledge(s.pairs[0], advisor, m.id));
  await store.transaction((s) => unpair(s, pair.id, main));
  const actual = await store.read();
  expect(actual.pairs[0].closed).toBe(true);
  expect(actual.pairs[0].messages[0].delivery.state).toBe("acknowledged");
});

it("archives only closed pairs, frees capacity, and reads exact retained history", async () => {
  const { store, state, pair } = fixture();
  enqueue(pair, "retained request", { dedupe: "original" });
  sendMessage(pair, main, "advisor", "retained message");
  unpair(state, pair.id, main);
  await store.transaction((s) => Object.assign(s, state));
  const original = structuredClone(pair);
  const archived = await store.archive(pair.id);
  expect(archived.id).toBe(pair.id);
  expect((await store.read()).pairs).toEqual([]);
  expect(await store.readPair(pair.id)).toEqual(original);
  expect(fs.statSync(archived.path).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(archived.path)).mode & 0o777).toBe(0o700);
  await store.transaction((s) => registerMain(s, main, { alive: () => true }));
  const live = (await store.read()).pairs[0];
  await expect(store.archive(live.id)).rejects.toThrow(/closed/);
  expect(await store.readPair(pair.id)).toEqual(original);
  expect((await store.archive(pair.id)).path).toBe(archived.path);
});

it("keeps the source after an interrupted archive commit and safely retries", async () => {
  const { store, state, pair } = fixture();
  enqueue(pair, "retain after failure");
  unpair(state, pair.id, main);
  await store.transaction((s) => Object.assign(s, state));
  const original = fs.readFileSync(store.file, "utf8");
  const rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === store.file) throw new Error("injected live commit failure");
    return rename(from, to);
  });
  try {
    await expect(store.archive(pair.id)).rejects.toThrow("injected live commit failure");
  } finally {
    fault.mockRestore();
  }
  expect(fs.readFileSync(store.file, "utf8")).toBe(original);
  await store.archive(pair.id);
  expect(await store.readPair(pair.id)).toEqual(pair);
  expect(
    fs.readdirSync(path.join(store.root, "archives")).filter((n) => n.endsWith(".json")),
  ).toHaveLength(1);
});

it("rejects corrupt, missing, and symlinked archived data without changing the catalog", async () => {
  const { store, state, pair } = fixture();
  unpair(state, pair.id, main);
  await store.transaction((s) => Object.assign(s, state));
  const archived = await store.archive(pair.id);
  const catalog = fs.readFileSync(store.file, "utf8");
  const content = fs.readFileSync(archived.path);
  const changed = Buffer.from(content);
  changed[0] ^= 1;
  fs.writeFileSync(archived.path, changed);
  await expect(store.readPair(pair.id)).rejects.toThrow(/checksum/);
  fs.writeFileSync(archived.path, "{}");
  await expect(store.readPair(pair.id)).rejects.toThrow(/size mismatch/);
  fs.unlinkSync(archived.path);
  await expect(store.readPair(pair.id)).rejects.toThrow(/archive/);
  const target = path.join(store.root, "target");
  fs.writeFileSync(target, content, { mode: 0o600 });
  fs.symlinkSync(target, archived.path);
  await expect(store.readPair(pair.id)).rejects.toThrow(/symlink/);
  expect(fs.readFileSync(store.file, "utf8")).toBe(catalog);
});

it("avoids serializing the complete snapshot twice for a no-op transaction", async () => {
  const { store, state } = fixture();
  await store.transaction((s) => Object.assign(s, state));
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    await store.transaction(() => undefined);
    expect(
      stringify.mock.calls.filter(([value]) => value?.version === 1 && value?.repo === "repo")
        .length,
    ).toBeLessThanOrEqual(1);
  } finally {
    stringify.mockRestore();
  }
});

it("archives a full valid legacy history and admits a new pair afterward", async () => {
  const { store, state, pair } = fixture();
  for (let n = 0; n < 2000; n++) {
    const r = enqueue(pair, "x".repeat(16384));
    r.state = "completed";
  }
  unpair(state, pair.id, main);
  let text = JSON.stringify(state) + "\n";
  while (Buffer.byteLength(text) < LIMIT) {
    // Build fixture history directly because the pair is already closed.
    pair.closed = false;
    const r = enqueue(pair, "x".repeat(16384));
    r.state = "completed";
    pair.closed = true;
    text = JSON.stringify(state) + "\n";
  }
  let excess = Buffer.byteLength(text) - LIMIT;
  for (const r of [...pair.requests].reverse()) {
    const remove = Math.min(excess, r.body.length - 1);
    r.body = r.body.slice(0, r.body.length - remove);
    excess -= remove;
    if (!excess) break;
  }
  text = JSON.stringify(state) + "\n";
  expect(Buffer.byteLength(text)).toBe(LIMIT);
  fs.writeFileSync(store.file, text, { mode: 0o600 });
  const archived = await store.archive(pair.id);
  expect(fs.statSync(archived.path).size).toBe(LIMIT);
  expect((await store.readPair(pair.id)).requests).toEqual(pair.requests);
  await store.transaction((s) => registerMain(s, main, { alive: () => true }));
  expect(fs.statSync(store.file).size).toBeLessThan(4096);
});

it("rejects a snapshot beyond bounded recovery capacity without replacing it", async () => {
  const { store, state } = fixture();
  await store.transaction((s) => Object.assign(s, state));
  fs.truncateSync(store.file, 48 * 1024 * 1024 + 1);
  await expect(store.read()).rejects.toThrow(/recovery capacity/);
  await expect(store.transaction(() => {})).rejects.toThrow(/recovery capacity/);
  expect(fs.statSync(store.file).size).toBe(48 * 1024 * 1024 + 1);
});

it("refuses traversal in an archive catalog and a symlinked archive directory", async () => {
  const { store, state, pair } = fixture();
  unpair(state, pair.id, main);
  await store.transaction((s) => Object.assign(s, state));
  const outside = makeTempDir("peer-archive-target-");
  fs.symlinkSync(outside, path.join(store.root, "archives"));
  await expect(store.archive(pair.id)).rejects.toThrow(/symlink/);
  fs.unlinkSync(path.join(store.root, "archives"));
  await store.archive(pair.id);
  const catalog = await store.read();
  catalog.archives[0].file = "../outside";
  fs.writeFileSync(store.file, JSON.stringify(catalog));
  await expect(store.readPair(pair.id)).rejects.toThrow(/archive catalog/);
});

it("accounts for JSON escaping when reserving a future final result", async () => {
  const { store, state } = fixture();
  const before = saveAtLimit(store, state, LIMIT - 80 * 1024);
  await expect(store.transaction((s) => enqueue(s.pairs[0], "small request"))).rejects.toThrow(
    /capacity/,
  );
  expect(fs.readFileSync(store.file, "utf8")).toBe(before);
});

it("names an eligible closed pair in the repository capacity diagnostic", async () => {
  const { store, state, pair } = fixture();
  unpair(state, pair.id, main);
  saveAtLimit(store, state);
  await expect(
    store.transaction((s) => registerMain(s, main, { alive: () => true })),
  ).rejects.toThrow(`dotbabel peer archive --pair ${pair.id}`);
});

it("refuses ambiguous duplicate pair IDs without dropping either history", async () => {
  const { store, state, pair } = fixture();
  enqueue(pair, "first history");
  unpair(state, pair.id, main);
  const second = structuredClone(pair);
  second.requests[0].body = "different second history";
  state.pairs.push(second);
  await store.transaction((s) => Object.assign(s, state));
  const before = fs.readFileSync(store.file, "utf8");
  await expect(store.archive(pair.id)).rejects.toThrow(/unique/);
  expect(fs.readFileSync(store.file, "utf8")).toBe(before);
});
