import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openClaudeSessionCache } from "../src/adaptive-session-routing/claude-session-cache.mjs";
import { createClaudeSessionInputLoader } from "../src/model-intelligence/cli/claude-session-input.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const session = "5f0c2a8e-1b2c-4d3e-9f00-0123456789ab";
const entry = observedAt => ({ observedAt, catalog: { sources: [], models: [], runtimes: [{ runtimeId: "claude", models: [{ fields: { id: [{ value: "claude-haiku-5-5", observedAt }] } }] }] } });
const box = () => { const root = makeTempDir("mi-claude-cache-"); return { root, env: { XDG_CACHE_HOME: join(root, "cache"), HOME: join(root, "home") }, dir: join(root, "cache", "dotbabel", "claude-routing") }; };

describe("Claude session catalog cache (persistent plugin)", () => {
  it("round-trips a verified catalog in an owner-only file that holds no prompt", async () => {
    const b = box(); const store = openClaudeSessionCache({ session, claudeVersion: "2.1.309", env: b.env });
    const now = new Date().toISOString();
    await store.write("/repo", entry(now));
    expect(await store.read("/repo")).toEqual(entry(now));
    expect(statSync(b.dir).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(b.dir);
    expect(statSync(join(b.dir, file)).mode & 0o777).toBe(0o600);
    expect(file).not.toContain(session);
    expect(readFileSync(join(b.dir, file), "utf8")).not.toMatch(/prompt|decision/);
  });

  it("keeps sessions, Claude releases and projects apart", async () => {
    const b = box(); const now = new Date().toISOString();
    await openClaudeSessionCache({ session, claudeVersion: "2.1.309", env: b.env }).write("/repo", entry(now));
    expect(await openClaudeSessionCache({ session: "other-session-0001", claudeVersion: "2.1.309", env: b.env }).read("/repo")).toBeUndefined();
    expect(await openClaudeSessionCache({ session, claudeVersion: "2.1.307", env: b.env }).read("/repo")).toBeUndefined();
    expect(await openClaudeSessionCache({ session, claudeVersion: "2.1.309", env: b.env }).read("/other")).toBeUndefined();
  });

  it("opens no store for a missing or unsafe session id or release", () => {
    const b = box();
    for (const bad of [undefined, "", "../etc", "a".repeat(129), "id with space"]) expect(openClaudeSessionCache({ session: bad, claudeVersion: "2.1.309", env: b.env }), String(bad)).toBeUndefined();
    expect(openClaudeSessionCache({ session, claudeVersion: "../x", env: b.env })).toBeUndefined();
  });

  it("ignores a corrupt, foreign or wrongly shaped file instead of trusting it", async () => {
    const b = box(); const store = openClaudeSessionCache({ session, claudeVersion: "2.1.309", env: b.env });
    await store.write("/repo", entry(new Date().toISOString()));
    const file = join(b.dir, readdirSync(b.dir)[0]);
    for (const body of ["not json", JSON.stringify({ repoRoot: "/elsewhere", claudeVersion: "2.1.309", observedAt: "x", catalog: {} }), JSON.stringify({ repoRoot: "/repo", claudeVersion: "2.1.309", observedAt: 3, catalog: null })]) {
      writeFileSync(file, body);
      expect(await store.read("/repo"), body).toBeUndefined();
    }
  });

  it("removes files older than one day when it writes", async () => {
    const b = box(); const store = openClaudeSessionCache({ session, claudeVersion: "2.1.309", env: b.env });
    await store.write("/old", entry(new Date().toISOString()));
    const old = join(b.dir, readdirSync(b.dir)[0]); const past = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old, past, past);
    await store.write("/repo", entry(new Date().toISOString()));
    expect(readdirSync(b.dir)).toHaveLength(1);
  });

  it("lets a new loader reuse the stored catalog without new runtime probes, and only while fresh", async () => {
    const store = { read: vi.fn(async () => entry(new Date().toISOString())), write: vi.fn() };
    const observe = vi.fn();
    const loader = createClaudeSessionInputLoader({ store, observe, loadPolicy: () => ({ shipped: { version: 1, classes: {} }, user: undefined, project: undefined }) });
    await expect(loader.load("/repo")).resolves.toMatchObject({ target: { runtimeId: "claude" } });
    expect(observe).not.toHaveBeenCalled();
    const stale = createClaudeSessionInputLoader({ store: { read: async () => entry("2020-01-01T00:00:00.000Z"), write: vi.fn() }, observe });
    await expect(stale.load("/repo")).rejects.toMatchObject({ code: "native_catalog_required" });
  });
});
