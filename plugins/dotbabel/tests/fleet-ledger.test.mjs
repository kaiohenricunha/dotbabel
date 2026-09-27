// Behavior tests for the on-disk claims ledger of `dotbabel fleet`: where it
// lives, atomic owner records, and the per-session denial log that drives
// escalation.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import {
  listRepoDirs,
  readDenials,
  readOwnerRecords,
  removeOwnerRecord,
  repoDir,
  stateRoot,
  writeDenials,
  writeOwnerRecord,
} from "../src/fleet/ledger.mjs";

function record(key, claims = []) {
  return {
    schema: 1,
    repo: "github.com/acme/widget",
    owner: { key, pid: Number(key.split("-")[0]), procStart: key.split("-")[1], sessionId: `s-${key}`, name: key },
    claims,
    updatedAt: "2026-09-25T12:00:00.000Z",
  };
}

describe("stateRoot", () => {
  it("prefers DOTBABEL_FLEET_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(stateRoot({ DOTBABEL_FLEET_STATE_DIR: "/s" }, "/home/me")).toBe("/s");
    expect(stateRoot({ XDG_STATE_HOME: "/x" }, "/home/me")).toBe(path.join("/x", "dotbabel", "fleet"));
    expect(stateRoot({}, "/home/me")).toBe(path.join("/home/me", ".local", "state", "dotbabel", "fleet"));
  });
});

describe("owner records", () => {
  it("round-trips a record and leaves no temp file behind", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "github.com/acme/widget");
    const rec = record("100-1", [{ pattern: "docs/a.md", source: "auto", claimedAt: "2026-09-25T12:00:00.000Z" }]);
    writeOwnerRecord(dir, rec);
    expect(fs.readdirSync(path.join(dir, "claims"))).toEqual(["100-1.json"]);
    expect(readOwnerRecords(dir)).toEqual([rec]);
  });

  it("overwrites the same owner's record in place", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "k");
    writeOwnerRecord(dir, record("100-1"));
    writeOwnerRecord(dir, record("100-1", [{ pattern: "x", claimedAt: "2026-09-25T12:00:00.000Z" }]));
    const all = readOwnerRecords(dir);
    expect(all).toHaveLength(1);
    expect(all[0].claims).toHaveLength(1);
  });

  it("skips malformed files and records of another schema", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "k");
    writeOwnerRecord(dir, record("100-1"));
    fs.writeFileSync(path.join(dir, "claims", "bad.json"), "{");
    fs.writeFileSync(path.join(dir, "claims", "old.json"), JSON.stringify({ ...record("200-2"), schema: 99 }));
    fs.writeFileSync(path.join(dir, "claims", "odd.json"), JSON.stringify({ schema: 1, owner: {}, claims: "no" }));
    expect(readOwnerRecords(dir).map((r) => r.owner.key)).toEqual(["100-1"]);
  });

  it("reads nothing from a repo that has no ledger yet", () => {
    expect(readOwnerRecords(repoDir(makeTempDir("fleet-state-"), "k"))).toEqual([]);
  });

  it("removes a record, and removing it twice is not an error", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "k");
    writeOwnerRecord(dir, record("100-1"));
    removeOwnerRecord(dir, "100-1");
    removeOwnerRecord(dir, "100-1");
    expect(readOwnerRecords(dir)).toEqual([]);
  });
});

describe("denials", () => {
  it("starts empty, round-trips, and deletes the file when emptied", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "k");
    expect(readDenials(dir, "100-1")).toEqual({});
    const log = { "docs/a.md": { owner: "200-2", firstDeniedAt: "2026-09-25T12:00:00.000Z" } };
    writeDenials(dir, "100-1", log);
    expect(readDenials(dir, "100-1")).toEqual(log);
    writeDenials(dir, "100-1", {});
    expect(fs.existsSync(path.join(dir, "denials", "100-1.json"))).toBe(false);
  });

  it("treats a corrupt denial file as empty", () => {
    const dir = repoDir(makeTempDir("fleet-state-"), "k");
    fs.mkdirSync(path.join(dir, "denials"), { recursive: true });
    fs.writeFileSync(path.join(dir, "denials", "100-1.json"), "[1,2");
    expect(readDenials(dir, "100-1")).toEqual({});
  });
});

describe("listRepoDirs", () => {
  it("lists every repo ledger under the state root", () => {
    const root = makeTempDir("fleet-state-");
    writeOwnerRecord(repoDir(root, "github.com/a/one"), record("1-1"));
    writeOwnerRecord(repoDir(root, "github.com/a/two"), record("2-2"));
    expect(listRepoDirs(root).map((d) => path.basename(d)).sort()).toEqual([
      "github.com_a_one",
      "github.com_a_two",
    ]);
    expect(listRepoDirs(path.join(root, "missing"))).toEqual([]);
  });
});
