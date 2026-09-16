import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RUNTIMES } from "../src/agents.mjs";

// bootstrap.sh is the npm-less install path: "Clone this repo and run
// ./bootstrap.sh. No npm required." (README.md:68, CLAUDE.md:9). It has no node
// dependency today, so it cannot read agents.mjs — shelling out to node to
// resolve the registry would break the single promise that path exists for.
//
// The list therefore stays hand-written in shell, and this test is what keeps it
// from drifting. Same technique as dotbabel-config-schema.test.mjs, which pins
// the JSON-Schema enum against KNOWN_FAN_OUT_CLIS for the same reason: a
// declaration that cannot import the registry gets asserted against it instead.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const bootstrapSh = fs.readFileSync(path.join(REPO_ROOT, "bootstrap.sh"), "utf8");

/** Runtime ids named by a `link_cli_instruction` / `fan_out_skills_to_dir` call. */
function calledIds(fn) {
  const pattern = new RegExp(String.raw`${fn}\s*(?:\\\s*)?\n?\s*([a-z][a-z0-9-]*)`, "g");
  return [...bootstrapSh.matchAll(pattern)].map((m) => m[1]);
}

describe("bootstrap.sh mirrors the agent registry", () => {
  it("links an instruction file for exactly the runtimes that declare one", () => {
    const expected = Object.values(RUNTIMES)
      .filter((runtime) => runtime.globalInstruction)
      .map((runtime) => runtime.id);
    expect(calledIds("link_cli_instruction").sort()).toEqual([...expected].sort());
  });

  it("uses each runtime's template file and destination", () => {
    for (const runtime of Object.values(RUNTIMES)) {
      if (!runtime.globalInstruction) continue;
      const { templateFile, dest } = runtime.globalInstruction;
      expect(
        bootstrapSh,
        `bootstrap.sh must link ${runtime.id} from ${templateFile}`,
      ).toContain(`"$CLI_INSTRUCTIONS_SRC/${templateFile}"`);
      expect(
        bootstrapSh,
        `bootstrap.sh must link ${runtime.id} to $HOME/${dest.join("/")}`,
      ).toContain(`"$HOME/${dest.join("/")}"`);
    }
  });

  it("fans out skills for exactly the runtimes that declare a skills dir", () => {
    const expected = Object.values(RUNTIMES)
      .filter((runtime) => runtime.globalSkills)
      .map((runtime) => runtime.id);
    expect(calledIds("fan_out_skills_to_dir").sort()).toEqual([...expected].sort());
  });

  it("honors each runtime's skills env-var override and default dir", () => {
    for (const runtime of Object.values(RUNTIMES)) {
      if (!runtime.globalSkills) continue;
      const { envVar, baseDir, subdir } = runtime.globalSkills;
      expect(
        bootstrapSh,
        `bootstrap.sh must resolve ${runtime.id} skills via ${envVar}`,
      ).toContain(`\${${envVar}:-$HOME/${baseDir}}/${subdir}`);
    }
  });

  it("names no CLI the registry does not know", () => {
    const known = new Set(Object.keys(RUNTIMES));
    for (const id of [...calledIds("link_cli_instruction"), ...calledIds("fan_out_skills_to_dir")]) {
      expect(known, `bootstrap.sh names unknown CLI ${id}`).toContain(id);
    }
  });

  // A runtime whose executable differs from its id must be probed by the
  // executable. bootstrap.sh takes the CLI name as its first argument, so
  // without an explicit probe it would run `command -v antigravity` and never
  // find a real `agy` install — the shell-side twin of the id-vs-binary problem
  // the registry's detect list solves on the JS side.
  it("probes a runtime by its executable when that differs from its id", () => {
    for (const runtime of Object.values(RUNTIMES)) {
      if (!runtime.globalSkills) continue;
      const [probe] = runtime.detect;
      if (probe === runtime.id) continue;
      const call = new RegExp(
        String.raw`fan_out_skills_to_dir\s+${runtime.id}\s+"[^"]+"\s+${probe}\b`,
      );
      expect(
        bootstrapSh,
        `bootstrap.sh must probe ${runtime.id} as \`${probe}\``,
      ).toMatch(call);
    }
  });

  // Known, accepted divergence between the two bootstrap paths. The shell
  // helper takes a fourth `alt_probe` argument and passes `gh copilot --version`
  // for Copilot, so bootstrap.sh detects Copilot installed as a gh extension.
  // bootstrap-global.mjs probes only the `copilot` binary via the registry's
  // detect list, so the npm path misses that install shape. Asserted here so the
  // difference is visible and deliberate rather than discovered later; unifying
  // it changes detection behaviour and belongs in its own change, not a
  // behaviour-preserving refactor.
  it("documents the Copilot gh-extension probe that only the shell path has", () => {
    expect(bootstrapSh).toContain('"gh copilot --version"');
    expect(RUNTIMES.copilot.detect).toEqual(["copilot"]);
  });
});
