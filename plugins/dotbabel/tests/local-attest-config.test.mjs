import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ConfigError,
  DEFAULTS,
  loadConfig,
  validateConfig,
} from "../src/local-attest-config.mjs";

const FIXTURES = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "fixtures", "local-attest");

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "local-attest-cfg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadConfig", () => {
  it("honors --config override", async () => {
    const cfg = await loadConfig({
      cwd: "/nowhere",
      override: join(FIXTURES, "valid.config.mjs"),
    });
    expect(cfg.matrix).toHaveLength(4);
    expect(cfg.label).toBe(DEFAULTS.label);
  });

  it("throws ConfigError with a hint when override file is missing", async () => {
    await expect(
      loadConfig({ cwd: "/nowhere", override: "/nope/missing.mjs" }),
    ).rejects.toMatchObject({
      name: "ConfigError",
      message: expect.stringContaining("not found"),
      hint: expect.stringContaining("references/config.md"),
    });
  });

  it("discovers .local-attest.config.mjs in cwd", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        join(dir, ".local-attest.config.mjs"),
        `export default { matrix: [{ name: "x", mode: "hard", command: "true" }] };\n`,
      );
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.matrix[0].name).toBe("x");
    } finally {
      cleanup();
    }
  });

  it("discovers .local-attest.config.json when .mjs is absent", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        join(dir, ".local-attest.config.json"),
        JSON.stringify({ matrix: [{ name: "j", mode: "hard", command: "true" }] }),
      );
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.matrix[0].name).toBe("j");
    } finally {
      cleanup();
    }
  });

  it("reads from package.json#local-attest as last fallback", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          "local-attest": {
            matrix: [{ name: "p", mode: "advisory", command: "true" }],
          },
        }),
      );
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.matrix[0]).toMatchObject({ name: "p", mode: "advisory" });
    } finally {
      cleanup();
    }
  });

  it("errors with a hint when no config exists anywhere", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      await expect(loadConfig({ cwd: dir })).rejects.toMatchObject({
        name: "ConfigError",
        message: expect.stringContaining("no .local-attest config found"),
        hint: expect.stringContaining("references/config.md"),
      });
    } finally {
      cleanup();
    }
  });
});

describe("validateConfig", () => {
  function base() {
    return {
      matrix: [
        { name: "a", mode: "hard", command: "true" },
        { name: "b", mode: "advisory", command: "true" },
      ],
    };
  }

  it("returns merged defaults for a minimal config", () => {
    const cfg = validateConfig(base());
    expect(cfg.label).toBe("ci/local-verified");
    expect(cfg.auditLogPath).toBe(".local-attest-log.jsonl");
    expect(cfg.trustedAssociations).toEqual(["OWNER"]);
    expect(cfg.requireClean).toBe(true);
    expect(cfg.requireDocker).toBe(false);
    expect(cfg.pushAfterAttest).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(() => validateConfig(null)).toThrow(ConfigError);
    expect(() => validateConfig("hi")).toThrow(ConfigError);
  });

  it("rejects empty matrix", () => {
    expect(() => validateConfig({ matrix: [] })).toThrow(/non-empty array/);
  });

  it("rejects matrix leg missing name", () => {
    expect(() => validateConfig({ matrix: [{ mode: "hard", command: "true" }] })).toThrow(
      /matrix\[0\]\.name/,
    );
  });

  it("rejects unknown mode", () => {
    expect(() =>
      validateConfig({ matrix: [{ name: "a", mode: "soft", command: "true" }] }),
    ).toThrow(/mode/);
  });

  it("rejects empty command", () => {
    expect(() => validateConfig({ matrix: [{ name: "a", mode: "hard", command: "" }] })).toThrow(
      /command/,
    );
  });

  it("rejects duplicate leg names", () => {
    const cfg = {
      matrix: [
        { name: "x", mode: "hard", command: "true" },
        { name: "x", mode: "hard", command: "true" },
      ],
    };
    expect(() => validateConfig(cfg)).toThrow(/duplicated/);
  });

  it("rejects auditLogPath with .. segments", () => {
    expect(() =>
      validateConfig({ ...base(), auditLogPath: "../escape.jsonl" }),
    ).toThrow(/\.\./);
  });

  it("rejects empty trustedAssociations", () => {
    expect(() => validateConfig({ ...base(), trustedAssociations: [] })).toThrow(
      /trustedAssociations/,
    );
  });

  it("rejects non-string trustedAssociations entries", () => {
    expect(() =>
      validateConfig({ ...base(), trustedAssociations: ["OWNER", 42] }),
    ).toThrow(/trustedAssociations/);
  });

  it("rejects non-boolean requireClean", () => {
    expect(() =>
      validateConfig({ ...base(), requireClean: "yes" }),
    ).toThrow(/requireClean/);
  });

  it("preserves matrix order", () => {
    const cfg = validateConfig({
      matrix: [
        { name: "z", mode: "hard", command: "true" },
        { name: "a", mode: "hard", command: "true" },
        { name: "m", mode: "advisory", command: "true" },
      ],
    });
    expect(cfg.matrix.map((l) => l.name)).toEqual(["z", "a", "m"]);
  });
});
