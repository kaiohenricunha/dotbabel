// npm installs package bins as node_modules/.bin symlinks, and bootstrap.sh
// symlinks skills into ~/.claude/skills/. Node realpath-resolves the ESM
// entry module (so import.meta.url points at the real file) but leaves
// process.argv[1] as the symlink path, so a run-direct guard that compares
// the two verbatim concludes the script was imported, not executed — and the
// process silently exits 0 having done nothing. These tests invoke each
// guarded script through a symlink, exactly like `npx <bin>` does, and expect
// the same loud behavior a direct invocation produces.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");
const REPO_ROOT = path.resolve(BIN_DIR, "../../..");

// Per-bin probe that only main() can satisfy. dotbabel-handoff parses argv at
// module top level, so a bogus flag exits 64 before the guard is ever
// consulted — a probe that must reach main() is the only non-vacuous one.
const PROBES = [
  {
    bin: "dotbabel-local-attest",
    args: ["--bogus-flag"],
    expects: (r) => {
      expect(r.status).toBe(64);
      expect(r.stderr).toMatch(/unknown argument/);
    },
  },
  {
    bin: "dotbabel-pr-stack",
    args: ["--bogus-flag"],
    expects: (r) => {
      expect(r.status).toBe(64);
      expect(r.stderr).toMatch(/Unknown option/);
    },
  },
  {
    bin: "dotbabel-handoff",
    args: [],
    expects: (r) => {
      // No-arg handoff prints usage from main() and exits 0; pre-fix the
      // guard miss produced the same exit 0 but with EMPTY stdout.
      expect(r.status).toBe(0);
      expect(r.stdout).not.toBe("");
    },
  },
];

const shimDir = mkdtempSync(path.join(tmpdir(), "dotbabel-bin-shim-"));
afterAll(() => rmSync(shimDir, { recursive: true, force: true }));

// Every .mjs file under dir, recursively (Node 20-compatible glob substitute).
function mjsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mjsFilesUnder(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

describe.each(PROBES)("$bin invoked through a .bin-style symlink", ({ bin, args, expects }) => {
  it("still runs main() instead of a silent exit 0", () => {
    const shim = path.join(shimDir, bin);
    symlinkSync(path.join(BIN_DIR, `${bin}.mjs`), shim);
    expects(spawnSync(process.execPath, [shim, ...args], { encoding: "utf8" }));
  });

  it("a residual guard miss trips the misfire tripwire instead of exiting 0", () => {
    // A wrapper file NAMED like the bin that merely imports it: argv[1]
    // basename matches, but the bin module is not the entry, so the guard
    // is (correctly) false — and for a bin name that must never mean a
    // silent success.
    const wrapperDir = mkdtempSync(path.join(shimDir, "wrap-"));
    const wrapper = path.join(wrapperDir, `${bin}.mjs`);
    writeFileSync(
      wrapper,
      `import ${JSON.stringify(pathToFileURL(path.join(BIN_DIR, `${bin}.mjs`)).href)};\n`,
    );
    const r = spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/guard did not fire/);
  });
});

describe("deploy-ops.mjs through a bootstrap-style symlink", () => {
  it("still runs main() — a no-args run dies loudly instead of a silent exit 0", () => {
    // In this repo, target resolution rejects before the usage branch, so the
    // exact code varies (2 here, 64 where targets exist) — the discriminator
    // against the pre-fix bug is exit 0 with NOTHING on either stream.
    const shim = path.join(shimDir, "deploy-ops.mjs");
    symlinkSync(path.join(REPO_ROOT, "skills/deploy-status/scripts/deploy-ops.mjs"), shim);
    const r = spawnSync(process.execPath, [shim], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toBe("");
  });
});

describe("no file reintroduces the symlink-blind guard", () => {
  it("pathToFileURL(process.argv[1]) never appears in a runnable script", () => {
    // The broken idiom compares the realpath-resolved entry URL against the
    // raw argv[1] URL. Every current guard goes through invokedDirectly()
    // (or deploy-ops' inlined realpath comparison), neither of which needs
    // this expression — so any new occurrence is a regression, most likely
    // copy-pasted from a pre-fix file.
    // Recursive readdir, not fs.globSync: engines say node >=20 and CI runs
    // a Node 20 leg, but globSync only exists from Node 22. Sweeping every
    // .mjs under these roots is also strictly broader than the old globs.
    const files = [
      ...mjsFilesUnder(BIN_DIR),
      ...mjsFilesUnder(path.join(REPO_ROOT, "skills")),
      ...mjsFilesUnder(path.join(REPO_ROOT, "plugins/dotbabel/templates")),
    ];
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) =>
      /pathToFileURL\(\s*process\.argv\[1\]\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
