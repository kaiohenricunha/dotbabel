/**
 * Canonical-only path resolution (`src/lib/paths.mjs`).
 *
 * These tests are the 3.0.0 replacement for `legacy-compat.test.mjs`: they
 * pin the post-removal contract — canonical always, no `~/.config/dotclaude/`
 * probe, no `DOTCLAUDE_*` fallback, no deprecation warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configDir, cacheDir } from "../src/lib/paths.mjs";

let HOME;
const saved = {};

beforeEach(() => {
  for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) saved[k] = process.env[k];
  HOME = mkdtempSync(join(tmpdir(), "dotbabel-paths-"));
  process.env.HOME = HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(HOME, { recursive: true, force: true });
});

describe("configDir()", () => {
  it("returns ~/.config/dotbabel when nothing exists on disk", () => {
    expect(configDir()).toBe(join(HOME, ".config", "dotbabel"));
  });

  it("honors XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = join(HOME, "xdg");
    expect(configDir()).toBe(join(HOME, "xdg", "dotbabel"));
  });

  it("resolves from an explicit env object without touching process.env", () => {
    expect(configDir({ HOME: "/somewhere" })).toBe(join("/somewhere", ".config", "dotbabel"));
  });

  it("falls back to an empty base when HOME is unset", () => {
    delete process.env.HOME;
    expect(configDir()).toBe(join(".config", "dotbabel"));
  });

  it("never falls back to ~/.config/dotclaude/, even when only it exists", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    mkdirSync(join(HOME, ".config", "dotclaude"), { recursive: true });
    expect(configDir()).toBe(join(HOME, ".config", "dotbabel"));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("cacheDir()", () => {
  it("returns ~/.cache/dotbabel when nothing exists on disk", () => {
    expect(cacheDir()).toBe(join(HOME, ".cache", "dotbabel"));
  });

  it("honors XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = join(HOME, "xdg-cache");
    expect(cacheDir()).toBe(join(HOME, "xdg-cache", "dotbabel"));
  });

  it("never falls back to ~/.cache/dotclaude/, even when only it exists", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    mkdirSync(join(HOME, ".cache", "dotclaude"), { recursive: true });
    expect(cacheDir()).toBe(join(HOME, ".cache", "dotbabel"));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("DOTCLAUDE_* env vars are inert", () => {
  it("DOTBABEL_DEBUG alone gates debug output; DOTCLAUDE_DEBUG does nothing", async () => {
    const { isDebug } = await import("../src/lib/debug.mjs");
    const savedDebug = process.env.DOTBABEL_DEBUG;
    delete process.env.DOTBABEL_DEBUG;
    process.env.DOTCLAUDE_DEBUG = "1";
    try {
      expect(isDebug()).toBe(false);
      process.env.DOTBABEL_DEBUG = "1";
      expect(isDebug()).toBe(true);
    } finally {
      delete process.env.DOTCLAUDE_DEBUG;
      if (savedDebug === undefined) delete process.env.DOTBABEL_DEBUG;
      else process.env.DOTBABEL_DEBUG = savedDebug;
    }
  });

  it("resolveSource ignores DOTCLAUDE_DIR", async () => {
    const { resolveSource } = await import("../src/bootstrap-global.mjs");
    expect(resolveSource(undefined, { DOTCLAUDE_DIR: "/legacy" })).not.toBe("/legacy");
    expect(resolveSource(undefined, { DOTBABEL_DIR: "/canonical" })).toBe("/canonical");
  });
});
