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
  resolveProjectSkillsDir,
  projectArtifactTargets,
  anyRuntimePresent,
  resolveGlobalSkillsDir,
} from "../src/agents.mjs";
import { KNOWN_FAN_OUT_CLIS, DEFAULT_PROJECT_CONFIG } from "../src/project-sync.mjs";
import { DEFAULT_TARGETS } from "../src/generate-instructions.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

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

// The registry only earns its place if it reproduces today's declarations
// exactly.
//
// Each test below anchors to a LITERAL first, then asserts the consumer agrees.
// The literal is what gives these teeth: the consumers now derive their values
// from the registry (KNOWN_FAN_OUT_CLIS is Object.freeze(fanOutRuntimes()),
// DEFAULT_PROJECT_CONFIG.targets maps projectArtifactTargets()), so a
// derived-vs-derived assertion compares a value with itself and can never fail.
// The derived half is kept because it documents the wiring; the literal half is
// what catches a registry edit that changes the public contract.
describe("agents registry — equivalence with existing declarations", () => {
  it("fanOutRuntimes() reproduces the documented fan-out list, order included", () => {
    expect(fanOutRuntimes()).toEqual(["codex", "gemini", "antigravity", "copilot"]);
    expect([...KNOWN_FAN_OUT_CLIS]).toEqual(fanOutRuntimes());
  });

  it("projectArtifactTargets() reproduces the historical default targets", () => {
    expect(projectArtifactTargets()).toEqual([
      { relativeOutputPath: "AGENTS.md", cliSet: ["copilot", "codex"], substitutionKey: "agents" },
      {
        relativeOutputPath: "GEMINI.md",
        cliSet: ["gemini", "antigravity"],
        substitutionKey: "gemini",
      },
      {
        relativeOutputPath: ".github/copilot-instructions.md",
        cliSet: ["copilot"],
        substitutionKey: "copilot",
      },
    ]);
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

  // The `.<id>/skills` convention held while every skills-dir runtime was named
  // after its own directory. Antigravity breaks it: its id is `antigravity` but
  // it reads `.agents/skills`, which is why the directory is registry data
  // rather than a string built from the id.
  it("skillDirRuntimes() maps each runtime to its documented skills dir", () => {
    expect(skillDirRuntimes()).toEqual(["codex", "gemini", "antigravity"]);
    expect(projectSkillsDir("codex")).toBe(".codex/skills");
    expect(projectSkillsDir("gemini")).toBe(".gemini/skills");
    expect(projectSkillsDir("antigravity")).toBe(".agents/skills");
  });

  // Only the runtimes whose trees are interchangeable may share one. Antigravity
  // is a skills-dir runtime that is NOT shareable, so this list is now a strict
  // subset — the case project-sync's shared-layout guard exists for.
  it("shareableSkillRuntimes() excludes the non-shareable skills-dir runtime", () => {
    expect(shareableSkillRuntimes()).toEqual(["codex", "gemini"]);
    expect(skillDirRuntimes()).toContain("antigravity");
    expect(shareableSkillRuntimes()).not.toContain("antigravity");
  });

  // project-sync.mjs used one list, SKILL_DIR_CLIS, to answer two questions:
  // which dispatch branch a runtime takes, and which runtimes can share one
  // canonical tree under fan_out_layout "shared". Those coincided until
  // Antigravity, which takes the skills-dir branch but cannot share the tree.
  // Splitting them in #363 is what let that runtime land without the shared
  // layout handing it a redirect it never follows.
  it("every shareable runtime is a skills-dir runtime that declares shareable", () => {
    for (const id of shareableSkillRuntimes()) {
      expect(skillDirRuntimes()).toContain(id);
      expect(RUNTIMES[id].projectFanOut.shareable).toBe(true);
    }
  });

  // project-sync.mjs destructures this list as exactly two (`const [a, b]`) to
  // warn that a `shared` layout drops a cli_excluded entry for both CLIs. A
  // third shareable runtime would compile, get a shared-tree symlink, and
  // silently vanish from that warning. Asserted separately from the equivalence
  // check above so the arity is not relaxed along with the contents.
  it("the shared-layout warning's two-runtime arity assumption still holds", () => {
    expect(shareableSkillRuntimes()).toHaveLength(2);
  });

  it("projectSkillsDir() is null for runtimes that write no skills tree", () => {
    expect(projectSkillsDir("copilot")).toBeNull();
    expect(projectSkillsDir("claude")).toBeNull();
  });

  it("resolveProjectSkillsDir() joins projectSkillsDir() under repoRoot", () => {
    expect(resolveProjectSkillsDir("gemini", "/repo")).toBe("/repo/.gemini/skills");
    expect(resolveProjectSkillsDir("codex", "/repo")).toBe("/repo/.codex/skills");
    expect(resolveProjectSkillsDir("copilot", "/repo")).toBeNull();
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
      "Antigravity",
      "Copilot",
    ]);
  });

  // The header states the rule: a shared artifact's key is neutral, a
  // single-runtime artifact's is its runtime's. Without this, changing
  // RUNTIMES.gemini.substitutionKey alone would render the project GEMINI.md
  // under the old key and gemini-GEMINI.md under the new one with the suite
  // green — the repo-facts test takes the union of both key sets, so it passes
  // either way.
  it("a single-runtime artifact reuses that runtime's substitution key", () => {
    for (const artifact of Object.values(INSTRUCTION_ARTIFACTS)) {
      if (artifact.runtimes.length !== 1) continue;
      expect(artifact.substitutionKey).toBe(RUNTIMES[artifact.runtimes[0]].substitutionKey);
    }
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

  // docs/repo-facts.json is JSON and cannot import the registry, so its
  // substitution keys are asserted against it instead — the same treatment the
  // JSON-Schema enum and bootstrap.sh get. The union is the point: `agents` is
  // an artifact key with no runtime, `codex` is a runtime key with no shared
  // artifact, and only the two concepts together account for every entry.
  it("repo-facts cli_substitutions keys are exactly the artifact and runtime keys", () => {
    const facts = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "docs", "repo-facts.json"), "utf8"),
    );
    const allowed = new Set([
      "_default_",
      ...Object.values(INSTRUCTION_ARTIFACTS).map((a) => a.substitutionKey),
      ...Object.values(RUNTIMES)
        .map((r) => r.substitutionKey)
        .filter(Boolean),
    ]);
    expect([...Object.keys(facts.cli_substitutions)].sort()).toEqual([...allowed].sort());
  });

  it("copilot fans out but owns no skills directory", () => {
    expect(RUNTIMES.copilot.projectFanOut.kind).toBe("copilot-files");
    expect(RUNTIMES.copilot.globalSkills).toBeNull();
    expect(skillDirRuntimes()).not.toContain("copilot");
  });
});

describe("anyRuntimePresent", () => {
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

// Antigravity is the first runtime whose executable name is not its id: the id
// is `antigravity`, the binary is `agy`. Every gate resolves the name through
// the registry's detect list, so probing `commandExists("antigravity")` — which
// is what the pre-registry code did with the bare cli string — would never find
// a real install.
describe("antigravity detection", () => {
  /** Put the named fake executables on an otherwise CLI-less PATH. */
  function stubBins(...names) {
    const bin = makeTmpDir("agents-stub-bin-");
    fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
    for (const name of names) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  }

  it("detects antigravity by its `agy` binary, not by its id", () => {
    expect(RUNTIMES.antigravity.detect).toEqual(["agy"]);
    stubBins("agy");
    expect(anyRuntimePresent(["antigravity"])).toBe(true);
  });

  it("agy only: antigravity present, gemini absent", () => {
    stubBins("agy");
    expect(anyRuntimePresent(["antigravity"])).toBe(true);
    expect(anyRuntimePresent(["gemini"])).toBe(false);
  });

  it("gemini only: gemini present, antigravity absent", () => {
    stubBins("gemini");
    expect(anyRuntimePresent(["gemini"])).toBe(true);
    expect(anyRuntimePresent(["antigravity"])).toBe(false);
  });

  it("both installed: each detected independently, and together", () => {
    stubBins("agy", "gemini");
    expect(anyRuntimePresent(["gemini"])).toBe(true);
    expect(anyRuntimePresent(["antigravity"])).toBe(true);
    expect(anyRuntimePresent(["gemini", "antigravity"])).toBe(true);
  });

  it("neither installed: both absent, and the shared pair is absent", () => {
    hideAllClisFromPath();
    expect(anyRuntimePresent(["gemini"])).toBe(false);
    expect(anyRuntimePresent(["antigravity"])).toBe(false);
    expect(anyRuntimePresent(["gemini", "antigravity"])).toBe(false);
  });
});

// The shared artifact is the whole point of splitting runtimes from artifacts:
// two runtimes, one GEMINI.md, expressed as set membership rather than an
// `if (gemini || agy)` repeated per call site.
describe("GEMINI.md as a shared instruction artifact", () => {
  it("is owned by exactly one artifact, listing both Google runtimes", () => {
    const owning = Object.values(INSTRUCTION_ARTIFACTS).filter(
      (a) => a.relativeOutputPath === "GEMINI.md",
    );
    expect(owning).toHaveLength(1);
    expect(owning[0].runtimes).toEqual(["gemini", "antigravity"]);
  });

  it("keeps the neutral-vs-own substitution-key split the header describes", () => {
    // Shared artifact keeps gemini's key rather than inventing a neutral one:
    // the file name and every path inside it are still Gemini's.
    expect(INSTRUCTION_ARTIFACTS.gemini.substitutionKey).toBe("gemini");
    // Antigravity ships no user-scope template of its own, so it has no key.
    expect(RUNTIMES.antigravity.substitutionKey).toBeNull();
    expect(RUNTIMES.antigravity.globalInstruction).toBeNull();
  });

  it("produces one GEMINI.md target, not one per reading runtime", () => {
    const geminiTargets = projectArtifactTargets().filter(
      (t) => t.relativeOutputPath === "GEMINI.md",
    );
    expect(geminiTargets).toHaveLength(1);
    expect(geminiTargets[0].cliSet).toEqual(["gemini", "antigravity"]);
  });

  it("resolves its audience as present when either runtime is installed", () => {
    const audience = INSTRUCTION_ARTIFACTS.gemini.runtimes;
    const bin = makeTmpDir("agents-stub-bin-");
    fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
    fs.writeFileSync(path.join(bin, "agy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = bin;

    // Gemini CLI absent, Antigravity present — the shared file still has a reader.
    expect(anyRuntimePresent(["gemini"])).toBe(false);
    expect(anyRuntimePresent([...audience])).toBe(true);
  });
});

describe("resolveGlobalSkillsDir", () => {
  it("defaults to <homeRoot>/<baseDir>/skills", () => {
    expect(resolveGlobalSkillsDir("gemini", "/home/u", {})).toBe("/home/u/.gemini/skills");
    expect(resolveGlobalSkillsDir("codex", "/home/u", {})).toBe("/home/u/.codex/skills");
  });

  // GEMINI_HOME / CODEX_HOME replace the whole config dir, not just its parent
  // (resolveGlobalSkillsDir in agents.mjs).
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
