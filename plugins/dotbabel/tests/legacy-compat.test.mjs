/**
 * Tests for the v1→v2 read-fallback compat layer.
 *
 * Asserts: canonical wins over legacy; absent canonical falls back; warnings
 * fire exactly once per (code, var-name) pair with the stable code from the
 * public contract; writes always target canonical.
 *
 * Warning capture: spies directly on `process.emitWarning` rather than
 * subscribing to the `warning` event. The event listener fires asynchronously
 * (and Node may suppress duplicate-code emissions at the listener level),
 * which makes the listener approach flaky for assertion. The spy records
 * every synchronous call, which is what these tests actually verify.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-import the module under test in each test so its internal Set<string>
// dedupe state is fresh — otherwise warnings from one test would suppress
// warnings in the next.
async function freshModule() {
  vi.resetModules();
  return await import("../src/lib/legacy-compat.mjs");
}

let HOME;
let originalEnv;
let warnSpy;

beforeEach(() => {
  originalEnv = { ...process.env };
  HOME = mkdtempSync(join(tmpdir(), "dotbabel-compat-"));
  process.env.HOME = HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DOTBABEL_") || k.startsWith("DOTCLAUDE_")) {
      delete process.env[k];
    }
  }
  // Spy on emitWarning for synchronous capture. mockImplementation prevents
  // the warning from being printed to stderr during the test run.
  warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(HOME, { recursive: true, force: true });
  process.env = originalEnv;
});

/**
 * Inspect every captured emitWarning call. Each spy call has shape
 * `[message, optionsObject]`. Returns parallel arrays for codes and messages.
 */
function captured() {
  const codes = [];
  const messages = [];
  for (const call of warnSpy.mock.calls) {
    const [message, opts] = call;
    messages.push(typeof message === "string" ? message : String(message));
    codes.push(opts && typeof opts === "object" ? opts.code : undefined);
  }
  return { codes, messages, callCount: warnSpy.mock.calls.length };
}

describe("configDir()", () => {
  it("returns canonical when only canonical exists", async () => {
    mkdirSync(join(HOME, ".config", "dotbabel"), { recursive: true });
    const { configDir } = await freshModule();
    expect(configDir()).toBe(join(HOME, ".config", "dotbabel"));
    expect(captured().codes).not.toContain("DOTBABEL_LEGACY_CONFIG");
  });

  it("falls back to legacy and warns once when only legacy exists", async () => {
    mkdirSync(join(HOME, ".config", "dotclaude"), { recursive: true });
    const { configDir } = await freshModule();
    expect(configDir()).toBe(join(HOME, ".config", "dotclaude"));
    configDir(); // second call must not emit
    configDir();
    const c = captured();
    expect(c.codes.filter((code) => code === "DOTBABEL_LEGACY_CONFIG")).toHaveLength(1);
    // Message must mention both old and new paths so users can migrate
    const warnMsg = c.messages.find((m) => /\.config\/dotclaude/.test(m));
    expect(warnMsg).toBeDefined();
    expect(warnMsg).toMatch(/dotbabel/);
  });

  it("returns canonical when both exist (no warning)", async () => {
    mkdirSync(join(HOME, ".config", "dotbabel"), { recursive: true });
    mkdirSync(join(HOME, ".config", "dotclaude"), { recursive: true });
    const { configDir } = await freshModule();
    expect(configDir()).toBe(join(HOME, ".config", "dotbabel"));
    expect(captured().codes).not.toContain("DOTBABEL_LEGACY_CONFIG");
  });

  it("returns canonical (as first-write target) when neither exists", async () => {
    const { configDir } = await freshModule();
    expect(configDir()).toBe(join(HOME, ".config", "dotbabel"));
    expect(captured().codes).not.toContain("DOTBABEL_LEGACY_CONFIG");
  });
});

describe("cacheDir()", () => {
  it("falls back to legacy and warns once when only legacy exists", async () => {
    mkdirSync(join(HOME, ".cache", "dotclaude"), { recursive: true });
    const { cacheDir } = await freshModule();
    expect(cacheDir()).toBe(join(HOME, ".cache", "dotclaude"));
    cacheDir();
    expect(captured().codes.filter((c) => c === "DOTBABEL_LEGACY_CACHE")).toHaveLength(1);
  });

  it("canonical wins when both exist", async () => {
    mkdirSync(join(HOME, ".cache", "dotbabel"), { recursive: true });
    mkdirSync(join(HOME, ".cache", "dotclaude"), { recursive: true });
    const { cacheDir } = await freshModule();
    expect(cacheDir()).toBe(join(HOME, ".cache", "dotbabel"));
    expect(captured().codes).not.toContain("DOTBABEL_LEGACY_CACHE");
  });
});

describe("env()", () => {
  it("canonical wins over legacy", async () => {
    process.env.DOTBABEL_HANDOFF_REPO = "canonical";
    process.env.DOTCLAUDE_HANDOFF_REPO = "legacy";
    const { env } = await freshModule();
    expect(env("HANDOFF_REPO")).toBe("canonical");
    expect(captured().codes).not.toContain("DOTBABEL_LEGACY_ENV");
  });

  it("falls back to legacy and warns with bare DOTBABEL_LEGACY_ENV code", async () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "legacy-only";
    const { env } = await freshModule();
    expect(env("HANDOFF_REPO")).toBe("legacy-only");
    const c = captured();
    const envWarnings = c.codes.filter((code) => code === "DOTBABEL_LEGACY_ENV");
    expect(envWarnings).toHaveLength(1);
    // Message must name both legacy and canonical so users know which to migrate
    const m = c.messages.find((msg) => /DOTCLAUDE_HANDOFF_REPO/.test(msg));
    expect(m).toBeDefined();
    expect(m).toContain("DOTBABEL_HANDOFF_REPO");
  });

  it("dedupe key is per-variable: HANDOFF_REPO and DIR fire independently", async () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "x";
    process.env.DOTCLAUDE_DIR = "y";
    const { env } = await freshModule();
    env("HANDOFF_REPO");
    env("DIR");
    env("HANDOFF_REPO"); // dedupe — should NOT emit a third
    env("DIR");
    expect(captured().codes.filter((c) => c === "DOTBABEL_LEGACY_ENV")).toHaveLength(2);
  });

  it("returns undefined when neither set", async () => {
    const { env } = await freshModule();
    expect(env("NOT_SET")).toBeUndefined();
    expect(captured().callCount).toBe(0);
  });

  it("all 12 mapped env vars fall back correctly", async () => {
    const vars = [
      "HANDOFF_REPO",
      "DIR",
      "DEBUG",
      "QUIET",
      "REPO_ROOT",
      "JSON",
      "DOCTOR_SH",
      "JSON_BUFFER",
      "VERSION",
      "SKIP_BOOTSTRAP",
      "HANDOFF_DEBUG",
      "GH_TOKEN",
    ];
    for (const v of vars) {
      process.env[`DOTCLAUDE_${v}`] = `legacy-${v}`;
    }
    const { env } = await freshModule();
    for (const v of vars) {
      expect(env(v)).toBe(`legacy-${v}`);
    }
    // Each distinct variable should fire its own warning
    expect(captured().codes.filter((c) => c === "DOTBABEL_LEGACY_ENV")).toHaveLength(vars.length);
  });
});

describe("setEnv() / unsetEnv()", () => {
  it("setEnv writes only to canonical", async () => {
    const { setEnv } = await freshModule();
    setEnv("HANDOFF_REPO", "new-value");
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBe("new-value");
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBeUndefined();
  });

  it("unsetEnv clears both canonical and legacy", async () => {
    process.env.DOTBABEL_HANDOFF_REPO = "x";
    process.env.DOTCLAUDE_HANDOFF_REPO = "y";
    const { unsetEnv } = await freshModule();
    unsetEnv("HANDOFF_REPO");
    expect(process.env.DOTBABEL_HANDOFF_REPO).toBeUndefined();
    expect(process.env.DOTCLAUDE_HANDOFF_REPO).toBeUndefined();
  });
});
