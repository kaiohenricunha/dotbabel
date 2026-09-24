// Additive boundary tests for `spec-harness-lib.mjs`, closing the gap
// between spec-harness-lib.test.mjs's coverage and the TEST-1 mutation-score
// floor (baseline 74.91%, 283 mutants). Several of the source's subprocess
// fallback paths (git resolution, `git diff`) are exercised in the existing
// file only via REAL subprocesses run in a non-git directory — deliberately,
// so the git-not-found behavior is genuine — but that means Stryker's
// in-process coverage instrumentation never sees those lines execute, so
// they show as NoCoverage no matter how solid the subprocess test is. This
// file adds `vi.doMock("node:child_process", ...)` based in-process tests
// alongside the existing subprocess ones, to close that instrumentation gap
// without weakening the subprocess tests' own guarantee.
//
// Several mutants are documented as genuinely equivalent rather than
// chased:
//   - 114:73-79 (`readFileSync(..., "utf8")` -> `""` in `readJson`): same
//     Buffer-vs-string coercion equivalence already established for
//     spec-file.mjs and confirm.mjs — `JSON.parse` accepts a Buffer via its
//     default (utf8) `.toString()`, identical to the explicit encoding.
//   - 376:10-26 (`while (i < input.length)` -> `i <= input.length` in
//     `stripHtmlComments`): the one extra out-of-bounds iteration pushes
//     `input[input.length]`, which is `undefined` — and
//     `Array.prototype.join("")` renders `undefined` as `""`, so the final
//     joined string is byte-identical either way. Confirmed directly:
//     `["a", undefined, "b"].join("") === "ab"`.
//   - 378:40-45 (`input.indexOf("-->", i + 4)` -> `i - 4` in
//     `stripHtmlComments`): NOT chased, and deliberately not attempted.
//     Proven by construction that any input placing a stray "-->" inside
//     the mutant's shifted (and possibly negative, clamped-to-0) search
//     window either fails to make forward progress — because the 3-byte
//     "-->" match and the 4-byte "<!--" window leave no integer position
//     that both lands in `[i-4, i)` and satisfies `end+3 > i` — or overlaps
//     the "<!--" marker itself, invalidating the premise. Every input of
//     that shape drives the mutated function into a genuine infinite loop
//     (traced by hand: the same `indexOf` call re-fires at the same `i` on
//     every pass). Forcing a kill here risks hanging the suite; not worth
//     it when the mutant is already one of the file's many timeout-status
//     entries in a full, untargeted mutation run.
//   - 415:17-52 and 415:50-52 (`process.env.GITHUB_EVENT_NAME ?? ""` and its
//     fallback text, in `getPullRequestContext`): the local `event`
//     variable is used exactly once, in `event === "pull_request"`, and is
//     never returned or read again — neither `""` nor `undefined` (what the
//     `&&` mutant produces) nor "Stryker was here!" ever equals
//     "pull_request", so `isPullRequest`'s value is identical for all three.
import { describe, it, expect, vi, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import {
  createHarnessContext,
  isSafeRelativePath,
  listRepoPaths,
  matchesGlob,
  anyPathMatches,
  extractTemplateSection,
  isMeaningfulSection,
  getPullRequestContext,
  getChangedFiles,
  git,
} from "../src/spec-harness-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_URL = new URL("../src/spec-harness-lib.mjs", import.meta.url).href;

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-harness-lib-behavior-"));
  dirs.push(dir);
  return dir;
}

/**
 * Load a fresh, module-scoped instance of spec-harness-lib.mjs with
 * `node:child_process`'s `execFileSync` replaced, without disturbing this
 * file's top-level static import (used by every other test here).
 */
async function withMockedExecFileSync(impl, fn) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({ execFileSync: impl }));
  try {
    const mod = await import(SRC_URL);
    return await fn(mod);
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

describe("isSafeRelativePath — drive-letter detection", () => {
  it("does not reject a path merely because 'X:' appears somewhere other than the start", () => {
    // A missing `^` anchor would make /[A-Za-z]:/ match "C:" anywhere in
    // the string, not only a real drive-letter prefix.
    expect(isSafeRelativePath("docs/C:foo")).toBe(true);
  });

  it("rejects a real rooted drive-letter path", () => {
    expect(isSafeRelativePath("C:/Windows/System32")).toBe(false);
  });

  it("accepts '.', which resolves to the virtual root exactly, not just under it", () => {
    expect(isSafeRelativePath(".")).toBe(true);
  });
});

describe("git() — exact messages and trimming", () => {
  it("names the exact type of a non-string arg in the TypeError", () => {
    const ctx = createHarnessContext({ repoRoot: "/some/path" });
    expect(() => git(ctx, [123])).toThrow("git args must be strings");
  });

  it("names (none) for an empty arg list, not the literal word undefined", () => {
    const ctx = createHarnessContext({ repoRoot: "/some/path" });
    expect(() => git(ctx, [])).toThrow("git: refusing git subcommand: (none)");
  });

  it("trims trailing whitespace from a real git command's stdout", () => {
    const ctx = createHarnessContext({ repoRoot: path.join(__dirname, "..", "..", "..") });
    const out = git(ctx, ["rev-parse", "--show-toplevel"]);
    expect(out).toBe(out.trim());
    expect(out.endsWith("\n")).toBe(false);
  });
});

describe("listSpecDirs — filters to directories and sorts the result", () => {
  it("excludes a non-directory entry and returns directory names in sorted order", async () => {
    vi.resetModules();
    vi.doMock("fs", async () => {
      const real = await vi.importActual("fs");
      return {
        ...real,
        readdirSync: () => [
          { name: "zeta", isDirectory: () => true },
          { name: "README.md", isDirectory: () => false }, // must be filtered out
          { name: "alpha", isDirectory: () => true },
        ],
      };
    });
    try {
      const mod = await import(SRC_URL);
      expect(mod.listSpecDirs({ specsRoot: "/fake-specs" })).toEqual(["alpha", "zeta"]);
    } finally {
      vi.doUnmock("fs");
      vi.resetModules();
    }
  });
});

describe("listRepoPaths — sort, top-level skip, and nested skip", () => {
  it("returns paths in sorted order even when the underlying directory listing is not", async () => {
    // Mock fs.readdirSync directly so the traversal order is deterministic
    // and deliberately NOT alphabetical, regardless of the host filesystem.
    vi.resetModules();
    vi.doMock("fs", async () => {
      const real = await vi.importActual("fs");
      const layout = {
        "/fake-repo": [
          { name: "zebra.txt", isDirectory: () => false },
          { name: "alpha-dir", isDirectory: () => true },
        ],
        "/fake-repo/alpha-dir": [{ name: "nested.txt", isDirectory: () => false }],
      };
      return {
        ...real,
        readdirSync: (dir) => layout[dir] ?? [],
      };
    });
    try {
      const mod = await import(SRC_URL);
      const ctx = { repoRoot: "/fake-repo" };
      expect(mod.listRepoPaths(ctx)).toEqual(["alpha-dir/nested.txt", "zebra.txt"]);
    } finally {
      vi.doUnmock("fs");
      vi.resetModules();
    }
  });

  it("skips a default-ignored directory only at the top level, not when the same name appears nested", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config"), "");
    fs.mkdirSync(path.join(root, "vendor", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "vendor", "node_modules", "keep.txt"), "");
    const paths = listRepoPaths({ repoRoot: root });
    expect(paths).not.toContain(".git/config"); // top-level .git IS skipped
    expect(paths).toContain("vendor/node_modules/keep.txt"); // nested node_modules is NOT
  });

  it("skips a nested directory that exactly matches the curated ignore list", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "tool.sh"), "");
    fs.writeFileSync(path.join(root, "keep.txt"), "");
    expect(listRepoPaths({ repoRoot: root })).toEqual(["keep.txt"]);
  });
});

describe("globToRegExp — ** lookahead, and ?", () => {
  it("requires the text after ** to still be honored, not swallowed by a backward-looking lookahead", () => {
    // An off-by-direction lookahead (checking glob[i-1] instead of
    // glob[i+1]) still ends up treating "**" as a multi-segment wildcard
    // for a bare "**" glob (the resulting regex is a differently-spelled
    // but equivalent "matches anything") — the bug only becomes observable
    // once a literal character follows the "**": the backward lookahead
    // consumes the wrong index pair and skips over that trailing literal
    // entirely, so it stops being required.
    expect(matchesGlob("a**b", "axyz")).toBe(false); // does not end in "b"
    expect(matchesGlob("a**b", "a/x/y/b")).toBe(true); // ends in "b", spans segments
  });

  it("treats ? as matching exactly one arbitrary character, not as a literal question mark", () => {
    expect(matchesGlob("?", "a")).toBe(true);
    expect(matchesGlob("?", "ab")).toBe(false); // exactly one char, not "at least one"
    expect(matchesGlob("a?c", "aXc")).toBe(true);
    expect(matchesGlob("a?c", "ac")).toBe(false); // the ? position must be filled
  });

  it("still treats a lone * as matching only within one path segment", () => {
    expect(matchesGlob("*", "a/b")).toBe(false);
    expect(matchesGlob("*", "a")).toBe(true);
  });
});

describe("anyPathMatches — some, not every, candidate must match", () => {
  it("matches a bare prefix pattern against only some of the candidate paths", () => {
    expect(anyPathMatches("docs/specs/foo", ["docs/specs/foo/spec.json", "unrelated/file.txt"])).toBe(true);
  });

  it("matches a glob pattern against only some of the candidate paths", () => {
    expect(anyPathMatches("*.md", ["readme.md", "notes.txt"])).toBe(true);
  });

  it("does not match when none of the candidates match a bare prefix pattern", () => {
    expect(anyPathMatches("docs/specs/foo", ["unrelated/file.txt"])).toBe(false);
  });

  it("does not match when none of the candidates match a glob pattern", () => {
    expect(anyPathMatches("*.md", ["notes.txt"])).toBe(false);
  });
});

describe("extractTemplateSection", () => {
  it("returns an empty string for a nullish body, without throwing", () => {
    expect(() => extractTemplateSection(undefined, "Spec ID")).not.toThrow();
    expect(extractTemplateSection(undefined, "Spec ID")).toBe("");
    expect(extractTemplateSection(null, "Spec ID")).toBe("");
  });

  it("matches the heading case-insensitively", () => {
    expect(extractTemplateSection("## spec id\nexample\n", "Spec ID")).toBe("example");
  });

  it("trims the matched section's content", () => {
    expect(extractTemplateSection("## Spec ID\n  \n  example  \n\n## Test plan\nx\n", "Spec ID")).toBe("example");
  });
});

describe("isMeaningfulSection", () => {
  it("treats a section that is only whitespace, with no HTML comment, as not meaningful", () => {
    expect(isMeaningfulSection("   \n  \t \n")).toBe(false);
  });

  it("does not throw on a nullish section", () => {
    expect(() => isMeaningfulSection(undefined)).not.toThrow();
    expect(isMeaningfulSection(undefined)).toBe(false);
  });
});

describe("getPullRequestContext — env boundaries", () => {
  const KEYS = ["GITHUB_EVENT_NAME", "PR_BODY", "PR_ACTOR", "GITHUB_ACTOR"];
  function withEnv(overrides, fn) {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    try {
      return fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it("is true only for the exact event name pull_request", () => {
    withEnv({ GITHUB_EVENT_NAME: "pull_request" }, () => {
      expect(getPullRequestContext().isPullRequest).toBe(true);
    });
  });

  it("is false for any other event name", () => {
    withEnv({ GITHUB_EVENT_NAME: "push" }, () => {
      expect(getPullRequestContext().isPullRequest).toBe(false);
    });
  });

  it("defaults body to an empty string, not undefined, when PR_BODY is unset", () => {
    withEnv({}, () => {
      expect(getPullRequestContext().body).toBe("");
    });
  });

  it("defaults actor to an empty string when neither PR_ACTOR nor GITHUB_ACTOR is set", () => {
    withEnv({}, () => {
      expect(getPullRequestContext().actor).toBe("");
    });
  });
});

describe("createHarnessContext — in-process git fallback", () => {
  it("uses the trimmed output of git rev-parse --show-toplevel with the exact expected argv", async () => {
    const calls = [];
    await withMockedExecFileSync(
      (cmd, args, opts) => {
        calls.push([cmd, args, opts]);
        return "/resolved/repo/root\n";
      },
      async (mod) => {
        const prevRoot = process.env.DOTBABEL_REPO_ROOT;
        delete process.env.DOTBABEL_REPO_ROOT;
        try {
          const ctx = mod.createHarnessContext();
          expect(ctx.repoRoot).toBe("/resolved/repo/root");
        } finally {
          if (prevRoot !== undefined) process.env.DOTBABEL_REPO_ROOT = prevRoot;
        }
      },
    );
    expect(calls).toEqual([["git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }]]);
  });

  it("throws the harness error, with its exact message, when git also fails", async () => {
    await withMockedExecFileSync(
      () => {
        throw new Error("not a git repository");
      },
      async (mod) => {
        const prevRoot = process.env.DOTBABEL_REPO_ROOT;
        delete process.env.DOTBABEL_REPO_ROOT;
        try {
          expect(() => mod.createHarnessContext()).toThrow(
            "harness: repoRoot not provided; pass { repoRoot } or set DOTBABEL_REPO_ROOT, or run inside a git repo",
          );
        } finally {
          if (prevRoot !== undefined) process.env.DOTBABEL_REPO_ROOT = prevRoot;
        }
      },
    );
  });

  it("routes the git failure through debug() under DOTBABEL_DEBUG=1, tagged git:rev-parse", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prevDebug = process.env.DOTBABEL_DEBUG;
    process.env.DOTBABEL_DEBUG = "1";
    try {
      await withMockedExecFileSync(
        () => {
          throw new Error("not a git repository");
        },
        async (mod) => {
          const prevRoot = process.env.DOTBABEL_REPO_ROOT;
          delete process.env.DOTBABEL_REPO_ROOT;
          try {
            expect(() => mod.createHarnessContext()).toThrow();
          } finally {
            if (prevRoot !== undefined) process.env.DOTBABEL_REPO_ROOT = prevRoot;
          }
        },
      );
      expect(writeSpy.mock.calls.some(([line]) => line.includes("git:rev-parse"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      if (prevDebug === undefined) delete process.env.DOTBABEL_DEBUG;
      else process.env.DOTBABEL_DEBUG = prevDebug;
    }
  });
});

describe("getChangedFiles — in-process git diff fallback", () => {
  function withoutCsv(fn) {
    const prev = process.env.HARNESS_CHANGED_FILES;
    delete process.env.HARNESS_CHANGED_FILES;
    try {
      return fn();
    } finally {
      if (prev !== undefined) process.env.HARNESS_CHANGED_FILES = prev;
    }
  }

  it("defaults the base ref to main and passes the exact expected argv", async () => {
    const calls = [];
    await withoutCsv(() =>
      withMockedExecFileSync(
        (cmd, args, opts) => {
          calls.push([cmd, args, opts]);
          return "";
        },
        async (mod) => {
          const prevBase = process.env.GITHUB_BASE_REF;
          delete process.env.GITHUB_BASE_REF;
          try {
            mod.getChangedFiles();
          } finally {
            if (prevBase !== undefined) process.env.GITHUB_BASE_REF = prevBase;
          }
        },
      ),
    );
    expect(calls).toEqual([["git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }]]);
  });

  it("uses GITHUB_BASE_REF over the main default when set", async () => {
    const calls = [];
    await withoutCsv(() =>
      withMockedExecFileSync(
        (cmd, args) => {
          calls.push(args);
          return "";
        },
        async (mod) => {
          process.env.GITHUB_BASE_REF = "develop";
          try {
            mod.getChangedFiles();
          } finally {
            delete process.env.GITHUB_BASE_REF;
          }
        },
      ),
    );
    expect(calls).toEqual([["diff", "--name-only", "origin/develop...HEAD"]]);
  });

  it("splits on newline and drops the trailing empty entry, not every character", async () => {
    await withoutCsv(() =>
      withMockedExecFileSync(
        () => "a.js\nb.js\n",
        async (mod) => {
          expect(mod.getChangedFiles()).toEqual(["a.js", "b.js"]);
        },
      ),
    );
  });

  it("returns [] and routes the failure through debug() tagged git:diff, rather than throwing", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prevDebug = process.env.DOTBABEL_DEBUG;
    process.env.DOTBABEL_DEBUG = "1";
    try {
      await withoutCsv(() =>
        withMockedExecFileSync(
          () => {
            throw new Error("fatal: bad revision");
          },
          async (mod) => {
            expect(mod.getChangedFiles()).toEqual([]);
          },
        ),
      );
      expect(writeSpy.mock.calls.some(([line]) => line.includes("git:diff"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      if (prevDebug === undefined) delete process.env.DOTBABEL_DEBUG;
      else process.env.DOTBABEL_DEBUG = prevDebug;
    }
  });
});
