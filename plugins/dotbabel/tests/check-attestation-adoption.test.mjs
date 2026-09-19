import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAttestationAdoption } from "../src/check-attestation-adoption.mjs";
import { ConfigError } from "../src/local-attest-config.mjs";

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/**
 * @param {{ dotbabel?: object|string|null, files?: Record<string,string> }} spec
 */
function repo({ dotbabel, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attest-adopt-"));
  tmpDirs.push(root);
  if (dotbabel !== undefined && dotbabel !== null) {
    fs.writeFileSync(
      path.join(root, ".dotbabel.json"),
      typeof dotbabel === "string" ? dotbabel : JSON.stringify(dotbabel),
    );
  }
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

const leg = (name, extra = {}) => ({ name, mode: "hard", command: `echo ${name}`, ...extra });
const matrixOf =
  (...legs) =>
  async () => ({ matrix: legs });
const codes = (r) => r.findings.map((f) => f.code);
const byCode = (r, code) => r.findings.find((f) => f.code === code);

describe("checkAttestationAdoption: enforcement off", () => {
  it("reports off, informational only, when there is no .dotbabel.json", async () => {
    const root = repo();
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(r.state).toBe("off");
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(["ATTESTATION_OFF"]);
    expect(byCode(r, "ATTESTATION_OFF").level).toBe("info");
  });

  it("reports off when .dotbabel.json has no attestation key", async () => {
    const root = repo({ dotbabel: { quality: { enabled: true } } });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(r.state).toBe("off");
    expect(codes(r)).toEqual(["ATTESTATION_OFF"]);
  });

  it("reports off when enforce is false or any non-true value", async () => {
    for (const enforce of [false, "true", 1, null]) {
      const root = repo({ dotbabel: { attestation: { enforce } } });
      const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
      expect(r.state, JSON.stringify(enforce)).toBe("off");
    }
  });

  it("points at the adoption guide when off", async () => {
    const root = repo();
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(byCode(r, "ATTESTATION_OFF").message).toContain("docs/attestation.md");
  });

  it("warns, not fails, when .dotbabel.json is unparseable, because the gate treats it as no policy", async () => {
    const root = repo({ dotbabel: "{ not json" });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(r.state).toBe("off");
    expect(r.ok).toBe(true);
    expect(byCode(r, "POLICY_UNREADABLE").level).toBe("warn");
  });
});

describe("checkAttestationAdoption: enforcement on", () => {
  const enforcing = (extra = {}) => ({
    attestation: { enforce: true, required_legs: ["test"], ...extra },
  });

  it("fails with NO_CONFIG when nothing can produce evidence", async () => {
    const root = repo({ dotbabel: enforcing() });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: true });
    expect(r.state).toBe("enforcing");
    expect(r.ok).toBe(false);
    expect(byCode(r, "NO_CONFIG").level).toBe("fail");
    expect(byCode(r, "NO_CONFIG").message).toMatch(/every pull request/i);
  });

  it("does not treat a package.json without a local-attest key as a config", async () => {
    const root = repo({ dotbabel: enforcing(), files: { "package.json": '{"name":"x"}' } });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: true });
    expect(codes(r)).toContain("NO_CONFIG");
  });

  it("does not load an executable config when execution is not permitted", async () => {
    const root = repo({
      dotbabel: enforcing(),
      files: { ".local-attest.config.mjs": "export default {}" },
    });
    let loaded = false;
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: false,
      loadConfigFn: async () => {
        loaded = true;
        return { matrix: [] };
      },
    });
    expect(loaded).toBe(false);
    expect(byCode(r, "LEGS_UNINSPECTED").level).toBe("warn");
    expect(codes(r)).not.toContain("NO_CONFIG");
    expect(r.ok).toBe(true);
  });

  it("loads a data-only config without needing execution permission", async () => {
    const root = repo({
      dotbabel: enforcing({ governance_files: [".dotbabel.json", ".local-attest.config.json"] }),
      files: { ".local-attest.config.json": "{}" },
    });
    let loaded = false;
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: false,
      loadConfigFn: async () => {
        loaded = true;
        return { matrix: [leg("test")] };
      },
    });
    expect(loaded).toBe(true);
    expect(codes(r)).not.toContain("LEGS_UNINSPECTED");
  });

  it("passes when the config is governed and every required leg exists", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    expect(r.ok).toBe(true);
    expect(r.findings.filter((f) => f.level === "fail" || f.level === "warn")).toEqual([]);
    expect(byCode(r, "ATTESTATION_ADOPTED").level).toBe("pass");
  });

  it("fails with CONFIG_UNGOVERNED when the config file is outside governance_files", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.json": "{}" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    const f = byCode(r, "CONFIG_UNGOVERNED");
    expect(f.level).toBe("fail");
    expect(f.message).toContain(".local-attest.config.json");
    expect(r.ok).toBe(false);
  });

  it("clears CONFIG_UNGOVERNED once the config file is listed", async () => {
    const root = repo({
      dotbabel: enforcing({ governance_files: [".dotbabel.json", ".local-attest.config.json"] }),
      files: { ".local-attest.config.json": "{}" },
    });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    expect(codes(r)).not.toContain("CONFIG_UNGOVERNED");
    expect(r.ok).toBe(true);
  });

  it("governs package.json#local-attest only when package.json is listed", async () => {
    const pkg = JSON.stringify({ "local-attest": { matrix: [] } });
    const ungoverned = repo({ dotbabel: enforcing(), files: { "package.json": pkg } });
    const governed = repo({
      dotbabel: enforcing({ governance_files: [".dotbabel.json", "package.json"] }),
      files: { "package.json": pkg },
    });
    const opts = { canExecuteConfig: true, loadConfigFn: matrixOf(leg("test")) };
    expect(codes(await checkAttestationAdoption({ repoRoot: ungoverned, ...opts }))).toContain(
      "CONFIG_UNGOVERNED",
    );
    expect(codes(await checkAttestationAdoption({ repoRoot: governed, ...opts }))).not.toContain(
      "CONFIG_UNGOVERNED",
    );
  });

  it("fails with REQUIRED_LEG_UNKNOWN naming a required leg no matrix entry provides", async () => {
    const root = repo({
      dotbabel: enforcing({ required_legs: ["test", "quality"] }),
      files: { ".local-attest.config.mjs": "" },
    });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    const f = byCode(r, "REQUIRED_LEG_UNKNOWN");
    expect(f.level).toBe("fail");
    expect(f.message).toContain("quality");
    expect(f.message).not.toMatch(/"test"/);
  });

  it("warns REQUIRED_LEG_SKIPPABLE for a required leg that can be skipped", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    for (const extra of [
      { when: { changedPaths: ["src/**"] } },
      { skipWhenDiffOnly: ["docs/**"] },
    ]) {
      const r = await checkAttestationAdoption({
        repoRoot: root,
        canExecuteConfig: true,
        loadConfigFn: matrixOf(leg("test", extra)),
      });
      expect(byCode(r, "REQUIRED_LEG_SKIPPABLE").level, JSON.stringify(extra)).toBe("warn");
    }
  });

  it("does not warn about skippable legs the policy does not require", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test"), leg("docs", { when: { changedPaths: ["docs/**"] } })),
    });
    expect(codes(r)).not.toContain("REQUIRED_LEG_SKIPPABLE");
  });

  it("warns NO_REQUIRED_LEGS when the policy names none", async () => {
    for (const attestation of [{ enforce: true }, { enforce: true, required_legs: [] }]) {
      const root = repo({ dotbabel: { attestation }, files: { ".local-attest.config.mjs": "" } });
      const r = await checkAttestationAdoption({
        repoRoot: root,
        canExecuteConfig: true,
        loadConfigFn: matrixOf(leg("test")),
      });
      expect(byCode(r, "NO_REQUIRED_LEGS").level).toBe("warn");
      expect(r.ok).toBe(true);
    }
  });

  it("reports NO_REQUIRED_LEGS even when the legs cannot be inspected", async () => {
    const root = repo({
      dotbabel: { attestation: { enforce: true } },
      files: { ".local-attest.config.mjs": "" },
    });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(codes(r)).toEqual(expect.arrayContaining(["NO_REQUIRED_LEGS", "LEGS_UNINSPECTED"]));
  });

  it("warns LEG_COMMAND_UNGOVERNED when a leg runs a package script and package.json is not governed", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    for (const command of ["npm test", "npm run lint", "pnpm test", "yarn test", "bun run test"]) {
      const r = await checkAttestationAdoption({
        repoRoot: root,
        canExecuteConfig: true,
        loadConfigFn: async () => ({ matrix: [leg("test", { command })] }),
      });
      const f = byCode(r, "LEG_COMMAND_UNGOVERNED");
      expect(f?.level, command).toBe("warn");
      expect(f.message).toContain("package.json");
    }
  });

  it("does not warn about package scripts when package.json is governed or the leg does not use one", async () => {
    const governed = repo({
      dotbabel: enforcing({
        governance_files: [".dotbabel.json", ".local-attest.config.mjs", "package.json"],
      }),
      files: { ".local-attest.config.mjs": "" },
    });
    const plain = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    const npmLeg = async () => ({ matrix: [leg("test", { command: "npm test" })] });
    const goLeg = async () => ({ matrix: [leg("test", { command: "go test ./..." })] });
    expect(
      codes(
        await checkAttestationAdoption({
          repoRoot: governed,
          canExecuteConfig: true,
          loadConfigFn: npmLeg,
        }),
      ),
    ).not.toContain("LEG_COMMAND_UNGOVERNED");
    expect(
      codes(
        await checkAttestationAdoption({
          repoRoot: plain,
          canExecuteConfig: true,
          loadConfigFn: goLeg,
        }),
      ),
    ).not.toContain("LEG_COMMAND_UNGOVERNED");
  });

  it("does not mistake a word that merely contains npm for a package runner", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: async () => ({
        matrix: [leg("test", { command: "./scripts/run-tests.sh --npmless" })],
      }),
    });
    expect(codes(r)).not.toContain("LEG_COMMAND_UNGOVERNED");
  });

  it("fails GOVERNANCE_PATH_INVALID for entries the gate drops and the producer still hashes", async () => {
    const root = repo({
      dotbabel: enforcing({
        governance_files: [
          ".dotbabel.json",
          ".local-attest.config.mjs",
          "../outside",
          "has space.txt",
          "/abs",
        ],
      }),
      files: { ".local-attest.config.mjs": "" },
    });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    const f = byCode(r, "GOVERNANCE_PATH_INVALID");
    expect(f.level).toBe("fail");
    expect(f.message).toContain("ATTESTATION_CONFIG_CHANGED");
    expect(r.ok).toBe(false);
    for (const bad of ["../outside", "has space.txt", "/abs"]) expect(f.message).toContain(bad);
    expect(f.message).not.toContain(".local-attest.config.mjs");
  });

  it("warns GOVERNED_FILE_MISSING for a declared entry that does not exist", async () => {
    const root = repo({
      dotbabel: enforcing({
        governance_files: [".dotbabel.json", ".local-attest.config.mjs", "Makefile"],
      }),
      files: { ".local-attest.config.mjs": "" },
    });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    const f = byCode(r, "GOVERNED_FILE_MISSING");
    expect(f.level).toBe("warn");
    expect(f.message).toContain("Makefile");
    expect(f.message).not.toContain(".local-attest.config.mjs");
  });

  it("does not report a missing file for the default governance list", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.json": "{}" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    expect(codes(r)).not.toContain("GOVERNED_FILE_MISSING");
  });

  it("fails with CONFIG_INVALID when the config cannot be loaded", async () => {
    const root = repo({ dotbabel: enforcing(), files: { ".local-attest.config.mjs": "" } });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: async () => {
        throw new ConfigError("matrix must be a non-empty array");
      },
    });
    const f = byCode(r, "CONFIG_INVALID");
    expect(f.level).toBe("fail");
    expect(f.message).toContain("matrix must be a non-empty array");
    expect(r.ok).toBe(false);
  });

  it("never reports ATTESTATION_ADOPTED alongside a fail", async () => {
    const root = repo({
      dotbabel: enforcing({ required_legs: ["nope"] }),
      files: { ".local-attest.config.mjs": "" },
    });
    const r = await checkAttestationAdoption({
      repoRoot: root,
      canExecuteConfig: true,
      loadConfigFn: matrixOf(leg("test")),
    });
    expect(r.ok).toBe(false);
    expect(codes(r)).not.toContain("ATTESTATION_ADOPTED");
  });
});

describe("checkAttestationAdoption: details that change what an operator does", () => {
  const enforcing = (extra = {}) => ({
    attestation: { enforce: true, required_legs: ["test"], ...extra },
  });
  const withMjs = { ".local-attest.config.mjs": "" };
  const run = (root, loadConfigFn) =>
    checkAttestationAdoption({ repoRoot: root, canExecuteConfig: true, loadConfigFn });

  it("mentions an existing config only when there is one, so the off message is not misleading", async () => {
    const without = await checkAttestationAdoption({ repoRoot: repo(), canExecuteConfig: false });
    const withCfg = await checkAttestationAdoption({
      repoRoot: repo({ files: withMjs }),
      canExecuteConfig: false,
    });
    expect(byCode(without, "ATTESTATION_OFF").message).not.toContain(
      "a local-attest config exists",
    );
    expect(byCode(withCfg, "ATTESTATION_OFF").message).toContain("a local-attest config exists");
  });

  it("reads a package.json#local-attest config as a config, and an empty one as none", async () => {
    const some = repo({ dotbabel: enforcing(), files: { "package.json": '{"local-attest":{}}' } });
    const none = repo({
      dotbabel: enforcing(),
      files: { "package.json": '{"local-attest":null}' },
    });
    expect(codes(await run(some, matrixOf(leg("test"))))).not.toContain("NO_CONFIG");
    expect(codes(await run(none, matrixOf(leg("test"))))).toContain("NO_CONFIG");
  });

  it("reports CONFIG_INVALID for an unparseable package.json instead of pretending there is no config", async () => {
    const root = repo({ dotbabel: enforcing(), files: { "package.json": "{ nope" } });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(byCode(r, "CONFIG_INVALID").message).toContain("package.json");
    expect(codes(r)).not.toContain("NO_CONFIG");
  });

  it("uses the real loader by default and hands it the repository root", async () => {
    const root = repo({
      dotbabel: enforcing({
        governance_files: [".dotbabel.json", ".local-attest.config.json"],
        required_legs: ["test", "ghost"],
      }),
      files: {
        ".local-attest.config.json": JSON.stringify({
          matrix: [{ name: "test", mode: "hard", command: "true" }],
        }),
      },
    });
    const r = await checkAttestationAdoption({ repoRoot: root, canExecuteConfig: false });
    expect(byCode(r, "REQUIRED_LEG_UNKNOWN").message).toContain('"ghost"');

    let seen;
    await run(root, async (args) => {
      seen = args;
      return { matrix: [leg("test")] };
    });
    expect(seen).toEqual({ cwd: root });
  });

  it("falls back to the default governance list when governance_files is empty", async () => {
    const root = repo({ dotbabel: enforcing({ governance_files: [] }), files: withMjs });
    const r = await run(root, matrixOf(leg("test")));
    expect(codes(r)).not.toContain("CONFIG_UNGOVERNED");
    expect(codes(r)).not.toContain("GOVERNED_FILE_MISSING");
  });

  it("reports no missing file when every declared entry exists", async () => {
    const root = repo({
      dotbabel: enforcing({
        governance_files: [".dotbabel.json", ".local-attest.config.mjs", "Makefile"],
      }),
      files: { ...withMjs, Makefile: "" },
    });
    expect(codes(await run(root, matrixOf(leg("test"))))).not.toContain("GOVERNED_FILE_MISSING");
  });

  it("does not call a configuration adopted while a warning is outstanding", async () => {
    const root = repo({ dotbabel: { attestation: { enforce: true } }, files: withMjs });
    const r = await run(root, matrixOf(leg("test")));
    expect(byCode(r, "NO_REQUIRED_LEGS")).toBeDefined();
    expect(codes(r)).not.toContain("ATTESTATION_ADOPTED");
    expect(r.ok).toBe(true);
  });

  it("agrees with itself on singular and plural wording", async () => {
    const one = repo({
      dotbabel: enforcing({
        governance_files: [".dotbabel.json", ".local-attest.config.mjs", "../a", "Makefile"],
      }),
      files: withMjs,
    });
    const two = repo({
      dotbabel: enforcing({
        governance_files: [
          ".dotbabel.json",
          ".local-attest.config.mjs",
          "../a",
          "b c",
          "Makefile",
          "Justfile",
        ],
      }),
      files: withMjs,
    });
    const npmLegs = async () => ({
      matrix: [leg("a", { command: "npm test" }), leg("b", { command: "yarn test" })],
    });
    const oneLeg = async () => ({ matrix: [leg("a", { command: "npm test" })] });

    const r1 = await run(one, oneLeg);
    const r2 = await run(two, npmLegs);
    expect(byCode(r1, "GOVERNANCE_PATH_INVALID").message).toContain("1 entry that must");
    expect(byCode(r2, "GOVERNANCE_PATH_INVALID").message).toContain("2 entries that must");
    expect(byCode(r1, "GOVERNED_FILE_MISSING").message).toMatch(/Makefile, which does not exist/);
    expect(byCode(r2, "GOVERNED_FILE_MISSING").message).toMatch(
      /Makefile, Justfile, which do not exist/,
    );
    expect(byCode(r1, "LEG_COMMAND_UNGOVERNED").message).toMatch(/"a" runs a package script/);
    expect(byCode(r2, "LEG_COMMAND_UNGOVERNED").message).toMatch(/"a", "b" run a package script/);
  });

  it("names the config file and the consequence in each failure message", async () => {
    const noConfig = await checkAttestationAdoption({
      repoRoot: repo({ dotbabel: enforcing() }),
      canExecuteConfig: true,
    });
    expect(byCode(noConfig, "NO_CONFIG").message).toContain("ATTESTATION_MISSING");

    const ungoverned = await run(
      repo({ dotbabel: enforcing({ governance_files: [".dotbabel.json"] }), files: withMjs }),
      matrixOf(leg("test")),
    );
    expect(byCode(ungoverned, "CONFIG_UNGOVERNED").message).toContain(".local-attest.config.mjs");
    expect(byCode(ungoverned, "CONFIG_UNGOVERNED").message).toContain("governance_files");

    const unknown = await run(
      repo({ dotbabel: enforcing({ required_legs: ["x"] }), files: withMjs }),
      matrixOf(leg("test")),
    );
    expect(byCode(unknown, "REQUIRED_LEG_UNKNOWN").message).toContain("ATTESTATION_INCOMPLETE");

    const skippable = await run(
      repo({ dotbabel: enforcing(), files: withMjs }),
      matrixOf(leg("test", { when: { changedPaths: ["a"] } })),
    );
    expect(byCode(skippable, "REQUIRED_LEG_SKIPPABLE").message).toContain('"test"');
    expect(byCode(skippable, "REQUIRED_LEG_SKIPPABLE").message).toContain("ATTESTATION_INCOMPLETE");

    const untrusted = await checkAttestationAdoption({
      repoRoot: repo({ dotbabel: enforcing(), files: withMjs }),
      canExecuteConfig: false,
    });
    expect(byCode(untrusted, "LEGS_UNINSPECTED").message).toContain(".local-attest.config.mjs");
    expect(byCode(untrusted, "LEGS_UNINSPECTED").message).toContain("project-init --trust");
  });

  it("recognises a package runner at the start, after a separator, and on its own", async () => {
    const { usesPackageRunner } = await import("../src/check-attestation-adoption.mjs");
    for (const yes of [
      "npm",
      "npm test",
      "cd app && npm test",
      "true;yarn test",
      "(pnpm i)",
      "a | bun run x",
      "x||npm t",
    ]) {
      expect(usesPackageRunner(yes), yes).toBe(true);
    }
    for (const no of ["mynpm test", "./npmless", "echo npmx", "make test", "", "go test ./..."]) {
      expect(usesPackageRunner(no), no).toBe(false);
    }
    expect(usesPackageRunner(undefined)).toBe(false);
    expect(usesPackageRunner(42)).toBe(false);
  });
});
