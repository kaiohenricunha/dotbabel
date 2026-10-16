import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { PeerStore } from "../../src/peer/store.mjs";

it("persists atomically, rolls back errors, refuses malformed state and uses private permissions", async () => {
  const root = makeTempDir("peer-store-"),
    store = new PeerStore(root, "repo");
  await store.transaction((s) => {
    s.counter = 1;
  });
  expect((await new PeerStore(root, "repo").read()).counter).toBe(1);
  await expect(
    store.transaction((s) => {
      s.counter = 2;
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect((await store.read()).counter).toBe(1);
  expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  fs.writeFileSync(store.file, "broken");
  await expect(store.read()).rejects.toThrow(/malformed/);
});
it("serializes concurrent enqueue transactions across independent processes", async () => {
  const root = makeTempDir("peer-concurrent-");
  const url = new URL("../../src/peer/store.mjs", import.meta.url).href;
  const source = `import {PeerStore} from ${JSON.stringify(url)}; const s=new PeerStore(process.argv[1], 'repo'); for(let n=0;n<12;n++) await s.transaction(x=>{x.counter=(x.counter??0)+1});`;
  await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", source, root], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          p.stderr.on("data", (x) => (err += x));
          p.on("error", reject);
          p.on("exit", (n) => (n === 0 ? resolve() : reject(new Error(err))));
        }),
    ),
  );
  expect((await new PeerStore(root, "repo").read()).counter).toBe(96);
});
it("isolates repository identities and rejects symlinks and foreign schemas", async () => {
  const root = makeTempDir("peer-boundary-"),
    a = new PeerStore(root, "a"),
    b = new PeerStore(root, "b");
  await a.transaction((s) => {
    s.marker = "a";
  });
  expect((await b.read()).marker).toBeUndefined();
  fs.writeFileSync(a.file, JSON.stringify({ version: 9, repo: "a", pairs: [] }));
  await expect(a.read()).rejects.toThrow(/version/);
  fs.unlinkSync(a.file);
  fs.symlinkSync(b.file, a.file);
  await expect(a.read()).rejects.toThrow(/symlink/);
  const link = path.join(root, "link");
  fs.symlinkSync(root, link);
  expect(() => new PeerStore(link, "repo")).toThrow(/symlink/);
});

it("recovers an aged lock from a terminated writer and preserves committed state", async () => {
  const root = makeTempDir("peer-crash-"),
    store = new PeerStore(root, "repo");
  await store.transaction((s) => {
    s.counter = 7;
  });
  const lockUrl = new URL("../../src/lib/process-lock.mjs", import.meta.url).href;
  const source = `import {acquireLock} from ${JSON.stringify(lockUrl)};const l=acquireLock(process.argv[1],{now:()=>Date.now()-600001});if(!l.acquired)process.exit(1);`;
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", source, store.lock], {
      stdio: "ignore",
    });
    p.on("error", reject);
    p.on("exit", (n) => (n === 0 ? resolve() : reject(new Error("fixture could not lock"))));
  });
  await new PeerStore(root, "repo").transaction((s) => {
    s.counter++;
  });
  expect((await store.read()).counter).toBe(8);
});
