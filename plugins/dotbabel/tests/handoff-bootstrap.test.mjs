// Tests for the self-bootstrap path in dotbabel-handoff:
//   - loadPersistedEnv parses ~/.config/dotbabel/handoff.env correctly
//   - isRepoMissingError classifies the "remote is gone" stderr variants
//   - the public SCHEMA_VERSION / readRemoteSchema exports are gone
//
// The interactive `bootstrapTransportRepo` itself isn't unit-tested here
// because it shells out to `gh` and `git` and expects a TTY; end-to-end
// coverage lives in plugins/dotbabel/tests/bats/handoff-binary-subs.bats.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshBinary() {
  // Clear the module cache so each test sees a fresh load — the binary
  // computes CONFIG_DIR/CONFIG_FILE at module scope from process.env.HOME.
  const url = new URL("../bin/dotbabel-handoff.mjs", import.meta.url);
  const busted = `${url.href}?t=${Date.now()}-${Math.random()}`;
  return await import(busted);
}

describe("module exports", () => {
  it("removes init-era helpers (SCHEMA_VERSION, readRemoteSchema, requireInitializedRepo)", async () => {
    const mod = await importFreshBinary();
    expect(mod.SCHEMA_VERSION).toBeUndefined();
    expect(mod.readRemoteSchema).toBeUndefined();
    expect(mod.requireInitializedRepo).toBeUndefined();
  });

  it("exports the new self-bootstrap helpers", async () => {
    const mod = await importFreshBinary();
    expect(typeof mod.loadPersistedEnv).toBe("function");
    expect(typeof mod.bootstrapTransportRepo).toBe("function");
    expect(typeof mod.isRepoMissingError).toBe("function");
    expect(typeof mod.requireTransportRepoStrict).toBe("function");
    expect(typeof mod.CONFIG_FILE).toBe("string");
  });
});

describe("loadPersistedEnv", () => {
  let home;
  let savedHome;
  let savedXdg;
  let savedRepo;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handoff-bootstrap-"));
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedRepo = process.env.DOTBABEL_HANDOFF_REPO;
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.DOTBABEL_HANDOFF_REPO;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedRepo === undefined) delete process.env.DOTBABEL_HANDOFF_REPO;
    else process.env.DOTBABEL_HANDOFF_REPO = savedRepo;
  });

  it("no-op when the config file is absent", async () => {
    const { loadPersistedEnv } = await importFreshBinary();
    loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBeUndefined();
  });

  it("sources KEY=VALUE lines when the var is unset", async () => {
    mkdirSync(join(home, ".config", "dotbabel"), { recursive: true });
    writeFileSync(
      join(home, ".config", "dotbabel", "handoff.env"),
      [
        "# a comment",
        "",
        "export DOTBABEL_HANDOFF_REPO=git@github.com:me/store.git",
      ].join("\n")
    );
    const { loadPersistedEnv } = await importFreshBinary();
    loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("git@github.com:me/store.git");
  });

  it("does NOT overwrite an already-set env var", async () => {
    mkdirSync(join(home, ".config", "dotbabel"), { recursive: true });
    writeFileSync(
      join(home, ".config", "dotbabel", "handoff.env"),
      "DOTBABEL_HANDOFF_REPO=git@github.com:from-file/store.git\n"
    );
    process.env.DOTBABEL_HANDOFF_REPO = "git@github.com:from-env/store.git";
    const { loadPersistedEnv } = await importFreshBinary();
    loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("git@github.com:from-env/store.git");
  });

  it("strips matching surrounding quotes on values", async () => {
    mkdirSync(join(home, ".config", "dotbabel"), { recursive: true });
    writeFileSync(
      join(home, ".config", "dotbabel", "handoff.env"),
      `DOTBABEL_HANDOFF_REPO="git@github.com:me/store.git"\n`
    );
    const { loadPersistedEnv } = await importFreshBinary();
    loadPersistedEnv();
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("git@github.com:me/store.git");
  });
});

describe("isRepoMissingError", () => {
  it("matches GitHub's phrasing", async () => {
    const { isRepoMissingError } = await importFreshBinary();
    expect(isRepoMissingError("ERROR: Repository not found.")).toBe(true);
    expect(isRepoMissingError("remote: Not Found")).toBe(true);
  });

  it("matches raw SSH/git phrasings", async () => {
    const { isRepoMissingError } = await importFreshBinary();
    expect(isRepoMissingError("fatal: Could not read from remote repository.")).toBe(true);
    expect(isRepoMissingError("fatal: 'x' does not appear to be a git repository")).toBe(true);
  });

  it("matches GitLab's phrasing", async () => {
    const { isRepoMissingError } = await importFreshBinary();
    expect(
      isRepoMissingError("fatal: the project you were looking for could not be found")
    ).toBe(true);
  });

  it("matches permission-denied (the auth-missing sibling of repo-missing)", async () => {
    const { isRepoMissingError } = await importFreshBinary();
    expect(isRepoMissingError("git@github.com: Permission denied (publickey).")).toBe(true);
  });

  it("ignores unrelated git errors", async () => {
    const { isRepoMissingError } = await importFreshBinary();
    expect(isRepoMissingError("fatal: not a git repository (or any of the parent directories)")).toBe(false);
    expect(isRepoMissingError("error: pathspec did not match any file(s) known to git")).toBe(false);
    expect(isRepoMissingError("")).toBe(false);
  });
});
