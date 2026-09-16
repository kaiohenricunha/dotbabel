import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  RUNTIMES,
  INSTRUCTION_ARTIFACTS,
  fanOutRuntimes,
  skillDirRuntimes,
  shareableSkillRuntimes,
  projectSkillsDir,
  projectArtifactTargets,
  anyRuntimePresent,
  resolveGlobalSkillsDir,
} from "../src/agents.mjs";
import { KNOWN_FAN_OUT_CLIS, DEFAULT_PROJECT_CONFIG } from "../src/project-sync.mjs";
import { DEFAULT_TARGETS } from "../src/generate-instructions.mjs";

let tmpDirs = [];
let savedPath = null;

function makeTmpDir(prefix = "agents-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function hideAllClisFromPath() {
  savedPath = process.env.PATH;
  const bin = makeTmpDir("agents-cliless-bin-");
  fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
  process.env.PATH = bin;
}

afterEach(() => {
  if (savedPath !== null) {
    process.env.PATH = savedPath;
    savedPath = null;
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// The registry only earns its place if it reproduces today's scattered
// declarations exactly. These are equivalence tests against the constants the
// refactor will delete, so a mismatch fails here rather than in the subsystem
// that consumes it later.
describe("agents registry — equivalence with existing declarations", () => {
  it("fanOutRuntimes() reproduces KNOWN_FAN_OUT_CLIS, order included", () => {
    expect(fanOutRuntimes()).toEqual([...KNOWN_FAN_OUT_CLIS]);
  });

  it("projectArtifactTargets() reproduces DEFAULT_PROJECT_CONFIG.targets", () => {
    expect(projectArtifactTargets()).toEqual(
      DEFAULT_PROJECT_CONFIG.targets.map((t) => ({
        relativeOutputPath: t.relativeOutputPath,
        cliSet: [...t.cliSet],
        substitutionKey: t.substitutionKey,
      })),
    );
  });

  it("projectArtifactTargets() matches the inject targets in DEFAULT_TARGETS", () => {
    const injectTargets = DEFAULT_TARGETS.filter((t) => t.mode === "inject").map((t) => ({
      relativeOutputPath: t.relativeOutputPath,
      cliSet: [...t.cliSet],
      substitutionKey: t.substitutionKey,
    }));
    expect(projectArtifactTargets()).toEqual(injectTargets);
  });

  // Each runtime's own global template carries that runtime's substitution key,
  // which is NOT the shared artifact's key: codex-AGENTS.md uses "codex" while
  // the project AGENTS.md two runtimes read uses the neutral "agents".
  it("runtime substitution keys match the synthesize targets in DEFAULT_TARGETS", () => {
    for (const target of DEFAULT_TARGETS.filter((t) => t.mode === "synthesize")) {
      const templateFile = path.basename(target.relativeOutputPath);
      const runtime = Object.values(RUNTIMES).find(
        (r) => r.globalInstruction?.templateFile === templateFile,
      );
      expect(runtime, `no runtime owns template ${templateFile}`).toBeDefined();
      expect(runtime.substitutionKey).toBe(target.substitutionKey);
      expect([...target.cliSet]).toEqual([runtime.id]);
    }
  });

  it("skillDirRuntimes() is the codex/gemini subset with .<id>/skills dirs", () => {
    expect(skillDirRuntimes()).toEqual(["codex", "gemini"]);
    for (const id of skillDirRuntimes()) {
      expect(projectSkillsDir(id)).toBe(`.${id}/skills`);
    }
  });

  // project-sync.mjs used one list, SKILL_DIR_CLIS, to answer two questions:
  // which dispatch branch a runtime takes, and which runtimes can share one
  // canonical tree under fan_out_layout "shared". They coincide today, which is
  // why one list worked; they are still separate questions, and the shared-tree
  // one is destructured as exactly two entries.
  it("shareableSkillRuntimes() matches SKILL_DIR_CLIS today and is a subset of skillDirRuntimes()", () => {
    expect(shareableSkillRuntimes()).toEqual(["codex", "gemini"]);
    for (const id of shareableSkillRuntimes()) {
      expect(skillDirRuntimes()).toContain(id);
      expect(RUNTIMES[id].projectFanOut.shareable).toBe(true);
    }
  });

  it("projectSkillsDir() is null for runtimes that write no skills tree", () => {
    expect(projectSkillsDir("copilot")).toBeNull();
    expect(projectSkillsDir("claude")).toBeNull();
  });

  // Global instruction destinations are per-runtime even where the project
  // artifact is shared: copilot and codex both read AGENTS.md in a repo, but
  // their user-scope files live in different private config dirs.
  it("global instruction destinations match what bootstrapGlobal links", () => {
    expect(RUNTIMES.copilot.globalInstruction).toEqual({
      templateFile: "copilot-instructions.md",
      dest: [".github", "copilot-instructions.md"],
    });
    expect(RUNTIMES.codex.globalInstruction).toEqual({
      templateFile: "codex-AGENTS.md",
      dest: [".codex", "AGENTS.md"],
    });
    expect(RUNTIMES.gemini.globalInstruction).toEqual({
      templateFile: "gemini-GEMINI.md",
      dest: [".gemini", "GEMINI.md"],
    });
  });
});

describe("agents registry — integrity", () => {
  it("every artifact names runtimes that exist", () => {
    for (const artifact of Object.values(INSTRUCTION_ARTIFACTS)) {
      for (const id of artifact.runtimes) {
        expect(RUNTIMES[id], `artifact ${artifact.key} names unknown runtime ${id}`).toBeDefined();
      }
    }
  });

  // dotbabel-doctor renders these, and its tests match on phrases like
  // /Codex skills fan-out/. A longer label would still pass those positive
  // matches' negative twins (`not.toMatch`) vacuously, so the exact strings are
  // pinned here rather than left to drift.
  it("renders the short labels doctor's output matches on", () => {
    expect(Object.values(RUNTIMES).map((r) => r.label)).toEqual([
      "Claude",
      "Codex",
      "Gemini",
      "Copilot",
    ]);
  });

  it("every runtime keys itself consistently", () => {
    for (const [key, runtime] of Object.entries(RUNTIMES)) {
      expect(runtime.id).toBe(key);
      expect(runtime.detect.length).toBeGreaterThan(0);
    }
  });

  // Claude is the tool dotbabel configures, not a fan-out destination: it is
  // never gated on presence and owns no per-CLI artifact.
  it("claude declares no artifact, global instruction, or fan-out", () => {
    expect(RUNTIMES.claude.globalInstruction).toBeNull();
    expect(RUNTIMES.claude.globalSkills).toBeNull();
    expect(RUNTIMES.claude.projectFanOut).toBeNull();
    for (const artifact of Object.values(INSTRUCTION_ARTIFACTS)) {
      expect(artifact.runtimes).not.toContain("claude");
    }
  });

  it("copilot fans out but owns no skills directory", () => {
    expect(RUNTIMES.copilot.projectFanOut.kind).toBe("copilot-files");
    expect(RUNTIMES.copilot.globalSkills).toBeNull();
    expect(skillDirRuntimes()).not.toContain("copilot");
  });
});

describe("anyRuntimePresent", () => {
  it("is true for any id when allCli is set, without probing PATH", () => {
    hideAllClisFromPath();
    expect(anyRuntimePresent(["gemini"], { allCli: true })).toBe(true);
  });

  it("is false when no runtime's executable is on PATH", () => {
    hideAllClisFromPath();
    expect(anyRuntimePresent(["gemini", "codex", "copilot"])).toBe(false);
  });

  it("is true when one of several runtimes is on PATH", () => {
    const bin = makeTmpDir("agents-stub-bin-");
    fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = bin;

    expect(anyRuntimePresent(["gemini", "codex"])).toBe(true);
    expect(anyRuntimePresent(["gemini"])).toBe(false);
  });

  it("is false for an empty id list", () => {
    expect(anyRuntimePresent([])).toBe(false);
  });
});

describe("resolveGlobalSkillsDir", () => {
  it("defaults to <homeRoot>/<baseDir>/skills", () => {
    expect(resolveGlobalSkillsDir("gemini", "/home/u", {})).toBe("/home/u/.gemini/skills");
    expect(resolveGlobalSkillsDir("codex", "/home/u", {})).toBe("/home/u/.codex/skills");
  });

  // GEMINI_HOME / CODEX_HOME replace the whole config dir, not just its parent
  // (bootstrap-global.mjs:244,253).
  it("honors the runtime's env-var override", () => {
    expect(resolveGlobalSkillsDir("gemini", "/home/u", { GEMINI_HOME: "/custom/g" })).toBe(
      "/custom/g/skills",
    );
    expect(resolveGlobalSkillsDir("codex", "/home/u", { CODEX_HOME: "/custom/c" })).toBe(
      "/custom/c/skills",
    );
  });

  it("returns null for a runtime with no global skills contract", () => {
    expect(resolveGlobalSkillsDir("copilot", "/home/u", {})).toBeNull();
    expect(resolveGlobalSkillsDir("claude", "/home/u", {})).toBeNull();
  });
});
