// Tests for src/clone-registry.mjs, the machine-level map from a repository
// key to its clones on this machine. Every test writes under its own temp
// directory, never under the developer's real state directory.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { REGISTRY_SCHEMA_VERSION, clonesOf, readRegistry, registerClone, registryFile } from "../src/clone-registry.mjs";

const REPO = "github.com/acme/widget";

function state() {
  return makeTempDir("clone-registry-");
}

function clone(name = "") {
  const dir = path.join(makeTempDir("clone-registry-clone-"), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

describe("registryFile", () => {
  it("lives under $XDG_STATE_HOME/dotbabel/graph, or ~/.local/state without it", () => {
    expect(registryFile({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "dotbabel", "graph", "clones.json"));
    expect(registryFile({}, "/home/u")).toBe(path.join("/home/u", ".local", "state", "dotbabel", "graph", "clones.json"));
  });
});

describe("readRegistry", () => {
  it("is empty when the file is missing, is not JSON, or has another schema version", () => {
    const dir = state();
    const empty = { schema_version: REGISTRY_SCHEMA_VERSION, repos: {} };
    expect(readRegistry(path.join(dir, "missing.json"))).toEqual(empty);
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(readRegistry(path.join(dir, "bad.json"))).toEqual(empty);
    fs.writeFileSync(path.join(dir, "v9.json"), JSON.stringify({ schema_version: 9, repos: { [REPO]: ["/x"] } }));
    expect(readRegistry(path.join(dir, "v9.json"))).toEqual(empty);
    fs.writeFileSync(path.join(dir, "shape.json"), JSON.stringify({ schema_version: 1, repos: [] }));
    expect(readRegistry(path.join(dir, "shape.json"))).toEqual(empty);
  });

  it("the clone registry drops a path that no longer exists", () => {
    const file = path.join(state(), "clones.json");
    const kept = clone();
    const gone = clone();
    registerClone(file, REPO, kept);
    registerClone(file, REPO, gone);
    expect(clonesOf(readRegistry(file), REPO)).toEqual([gone, kept].sort());
    fs.rmSync(gone, { recursive: true });
    // Dropped on read, before any write touches the file.
    expect(clonesOf(readRegistry(file), REPO)).toEqual([kept]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).repos[REPO]).toContain(gone);
    // The next write, under the lock, prunes the file.
    registerClone(file, REPO, kept);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).repos[REPO]).toEqual([kept]);
  });

  it("keeps only string paths and drops a repository with no clone left", () => {
    const file = path.join(state(), "clones.json");
    const kept = clone();
    fs.writeFileSync(
      file,
      JSON.stringify({ schema_version: 1, repos: { [REPO]: [kept, 7, null], "github.com/acme/gone": ["/nowhere/at/all"] } }),
    );
    expect(readRegistry(file)).toEqual({ schema_version: 1, repos: { [REPO]: [kept] } });
    expect(clonesOf(readRegistry(file), "github.com/acme/gone")).toEqual([]);
  });
});

describe("registerClone", () => {
  it("creates the file, adds a clone once, and keeps the paths of each repository sorted", () => {
    const file = path.join(state(), "nested", "clones.json");
    const a = clone("a");
    const b = clone("b");
    registerClone(file, REPO, b);
    registerClone(file, REPO, a);
    const written = registerClone(file, REPO, b);
    expect(written).toEqual({ schema_version: REGISTRY_SCHEMA_VERSION, repos: { [REPO]: [a, b].sort() } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(written);
    registerClone(file, "github.com/acme/other", a);
    expect(Object.keys(readRegistry(file).repos).sort()).toEqual(["github.com/acme/other", REPO].sort());
    expect(fs.readdirSync(path.dirname(file))).toEqual(["clones.json"]);
  });

  it("clears a stale lock and refuses while a live writer holds the lock", () => {
    const file = path.join(state(), "clones.json");
    const lock = `${file}.lock`;
    const here = clone();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(clonesOf(registerClone(file, REPO, here), REPO)).toEqual([here]);
    expect(fs.existsSync(lock)).toBe(false);
    fs.mkdirSync(lock);
    expect(() => registerClone(file, REPO, here, { waitMs: 50 })).toThrow(/clone registry lock is busy/);
    fs.rmSync(lock, { recursive: true });
  });
});
