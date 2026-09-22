import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import {
  DEAD_PROXY,
  MAX_OUTPUT_BYTES,
  buildIsolatedEnv,
  withScratchRoot,
  assertOutsideRoot,
  runProcess,
  assertOpaqueValue,
  parseVersion,
} from "../src/model-intelligence/sources/runtime/process.mjs";

const node = process.execPath;
/** Run a one-line script under the current node, the way an adapter would run a CLI. */
const script = (body, extra = {}) => ({ command: node, args: ["-e", body], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, ...extra });

describe("isolated environment", () => {
  it("copies PATH and nothing else from the source environment", () => {
    const source = { PATH: "/usr/bin", HOME: "/home/real", ANTHROPIC_API_KEY: "sk-ant-api03-AbCdEf0123456789", OPENAI_API_KEY: "sk-proj-abcdefghijklmnop", CODEX_HOME: "/home/real/.codex", XDG_CONFIG_HOME: "/home/real/.config" };
    const env = buildIsolatedEnv({ source, home: "/tmp/scratch/home" });
    // A credential in the caller's environment must not reach the runtime. This is what makes
    // a probe safe to run even when the runtime would accept the credential: with none, it cannot
    // bill a turn, whatever the classification logic does afterwards.
    expect(Object.keys(env).sort()).toEqual(["ALL_PROXY", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PATH", "TERM", "all_proxy", "http_proxy", "https_proxy"].sort());
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/scratch/home");
    expect(JSON.stringify(env)).not.toMatch(/sk-|real/);
  });

  it("points every proxy variable at a dead port so no request can leave the machine", () => {
    const env = buildIsolatedEnv({ source: { PATH: "/usr/bin" }, home: "/tmp/h" });
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) expect(env[key], key).toBe(DEAD_PROXY);
    // NO_PROXY is set empty, because an inherited NO_PROXY could exempt the provider host.
    expect(env.NO_PROXY).toBe("");
    expect(DEAD_PROXY).toBe("http://127.0.0.1:9");
  });

  it("adds only the extra variables the caller names, and refuses one that looks like a credential", () => {
    const env = buildIsolatedEnv({ source: { PATH: "/p" }, home: "/tmp/h", extra: { CODEX_HOME: "/tmp/scratch/ch" } });
    expect(env.CODEX_HOME).toBe("/tmp/scratch/ch");
    // The same considered word list `contract.mjs`'s diagnostic redaction uses (`isSecretName`), so
    // a name it treats as a credential -- including the whole-word forms PASS/PWD/PAT it added for
    // secrets a narrower name-only rule would miss -- is refused here too, not just a masked-KEY/TOKEN subset.
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GH_TOKEN", "MY_SECRET", "MYSQL_PASS", "GITHUB_PAT", "APP_PWD", "SESSION_ID", "GH_COOKIE"]) {
      expect(() => buildIsolatedEnv({ source: {}, home: "/tmp/h", extra: { [name]: "x" } }), name).toThrow(/credential/);
    }
    // A name that merely ends in a secret-looking suffix is not a false positive.
    expect(() => buildIsolatedEnv({ source: {}, home: "/tmp/h", extra: { COMPAT_LEVEL: "2" } })).not.toThrow();
  });

  it("refuses an extra variable that would override an isolation pin, rather than silently letting it win", () => {
    // `extra` used to spread last, so a caller (a future adapter, not any current call site) naming
    // one of these could unpin the scratch home or re-open the network with no error and no test
    // failure -- exactly the collision a name-based credential check cannot catch.
    for (const name of ["HOME", "PATH", "TERM", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "NO_PROXY"]) {
      expect(() => buildIsolatedEnv({ source: { PATH: "/p" }, home: "/tmp/h", extra: { [name]: "escaped" } }), name).toThrow(/isolation/);
    }
  });

  it("uses an empty PATH rather than crashing when the source has none", () => {
    expect(buildIsolatedEnv({ source: {}, home: "/tmp/h" }).PATH).toBe("");
  });
});

describe("scratch root", () => {
  it("creates a directory and removes it afterwards, including when the callback throws", async () => {
    let seen;
    await withScratchRoot("mi-test", async (root) => {
      seen = root;
      expect(existsSync(root)).toBe(true);
      writeFileSync(join(root, "state.db"), "x");
    });
    expect(existsSync(seen)).toBe(false);

    let failed;
    await expect(
      withScratchRoot("mi-test", async (root) => {
        failed = root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(failed)).toBe(false);
  });

  it("removes only the directory it created", async () => {
    const neighbour = makeTempDir("mi-neighbour-");
    writeFileSync(join(neighbour, "keep.txt"), "x");
    await withScratchRoot("mi-test", async () => {});
    expect(existsSync(join(neighbour, "keep.txt"))).toBe(true);
  });

  it("returns the callback's value", async () => {
    expect(await withScratchRoot("mi-test", async () => 42)).toBe(42);
  });
});

describe("assertOutsideRoot (SEC-1)", () => {
  it("accepts a path elsewhere and rejects the root itself and anything inside it", () => {
    const root = makeTempDir("mi-root-");
    const other = makeTempDir("mi-other-");
    expect(() => assertOutsideRoot(other, root)).not.toThrow();
    expect(() => assertOutsideRoot(root, root)).toThrow(/runtime configuration root/);
    expect(() => assertOutsideRoot(join(root, "sessions", "2026"), root)).toThrow(/runtime configuration root/);
    // A sibling whose name merely starts with the root's name is not inside it.
    expect(() => assertOutsideRoot(`${root}-sibling`, root)).not.toThrow();
    // Traversal is resolved before it is compared.
    expect(() => assertOutsideRoot(join(other, "..", root.split("/").pop(), "x"), root)).toThrow(/runtime configuration root/);
    // No root means nothing to protect.
    expect(() => assertOutsideRoot(other, undefined)).not.toThrow();
  });
});

describe("runProcess", () => {
  it("captures stdout, stderr and the exit code separately", async () => {
    const out = await runProcess(script("process.stdout.write('a'); process.stderr.write('b'); process.exit(3)"));
    expect(out).toMatchObject({ exitCode: 3, stdout: "a", stderr: "b", truncated: false, stoppedEarly: false, aborted: false });
  });

  it("never involves a shell, so an argument is passed literally", async () => {
    const hostile = "; echo pwned; $(id) `id` | cat";
    const out = await runProcess({ command: node, args: ["-e", "process.stdout.write(process.argv[1])", hostile], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
    expect(out.stdout).toBe(hostile);
  });

  it("passes exactly the environment it is given", async () => {
    const out = await runProcess(script("process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== 'PATH' && !k.startsWith('LC_') && k !== 'PWD' && k !== 'SHLVL' && k !== '_')))", { env: { PATH: process.env.PATH ?? "", ONLY_THIS: "1" } }));
    expect(JSON.parse(out.stdout)).toEqual(["ONLY_THIS"]);
  });

  it("stops a child early when the predicate is satisfied, instead of waiting for it to exit", async () => {
    // Codex prints its banner and then hangs retrying the network. Waiting for exit would run
    // into the timeout on every call, so the runner ends the child as soon as it has what it needs.
    const started = Date.now();
    const out = await runProcess(
      script("process.stderr.write('BANNER\\n'); setInterval(() => {}, 1000)", {
        stopWhen: ({ stderr }) => stderr.includes("BANNER"),
      }),
    );
    expect(out.stoppedEarly).toBe(true);
    expect(out.stderr).toContain("BANNER");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills the child when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runProcess(script("setInterval(() => {}, 1000)"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const out = await pending;
    expect(out.aborted).toBe(true);
    expect(out.signal).not.toBeNull();
  });

  it("stops and flags a child whose output exceeds the cap, rather than buffering without bound", async () => {
    const out = await runProcess(script("const chunk = 'x'.repeat(65536); const t = setInterval(() => process.stdout.write(chunk), 1);", { maxOutputBytes: 200_000 }));
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeLessThanOrEqual(200_000);
    expect(MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
  });

  it("shares one output budget across both streams, so a run cannot buffer double the cap", async () => {
    // Sequenced deliberately: stderr fills to just under the cap first, then (after it has landed)
    // stdout writes enough to push the COMBINED total over the cap while staying under the cap on
    // its own. Before this fix, `bytes` was tracked per stream, so neither write alone would trip
    // truncation and the run would buffer up to two times `maxOutputBytes` before anything noticed.
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 3_000);
    const body = "process.stderr.write('a'.repeat(60000)); setTimeout(() => { process.stdout.write('b'.repeat(60000)); setInterval(() => {}, 1000); }, 100);";
    const out = await runProcess(script(body, { maxOutputBytes: 100_000 }), { signal: controller.signal });
    clearTimeout(guard);
    expect(out.truncated).toBe(true);
    expect(out.stdout.length + out.stderr.length).toBeLessThanOrEqual(100_000);
  });

  it("rejects with the errno when the binary does not exist", async () => {
    await expect(runProcess({ command: "/definitely/not/a/binary", args: [], cwd: tmpdir(), env: {} })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not split a multibyte character across two chunks", async () => {
    const out = await runProcess(script("const b = Buffer.from('a\\u00e9b'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30)"));
    expect(out.stdout).toBe("aéb");
  });
});

describe("opaque values", () => {
  it("accepts an identifier as written and rejects anything that could be read as a flag or a control", () => {
    for (const good of ["opus", "claude-opus-5[1m]", "gpt-6-astra", "local-qwen/model#variant", "gemini-3.8-flash-high"]) {
      expect(() => assertOpaqueValue("model", good), good).not.toThrow();
    }
    // A value that starts with a dash would be parsed as a flag by the runtime, so it could carry
    // an option nobody asked for. Control characters could forge output or split a line.
    for (const bad of ["-x", "--model", "", "a".repeat(201), "line" + String.fromCharCode(10) + "break", "nul" + String.fromCharCode(0), "tab" + String.fromCharCode(9), 7, null, undefined, {}]) {
      expect(() => assertOpaqueValue("model", bad), String(bad).slice(0, 12)).toThrow(/model/);
    }
  });
});

describe("version parsing", () => {
  it("extracts the version from the way each runtime prints it", () => {
    expect(parseVersion("2.1.278 (Claude Code)")).toBe("2.1.278");
    expect(parseVersion("codex-cli 0.155.1")).toBe("0.155.1");
    expect(parseVersion("OpenAI Codex v0.155.1")).toBe("0.155.1");
    expect(parseVersion("agy 1.2.5-beta+build.7")).toBe("1.2.5-beta+build.7");
  });

  it("returns undefined for text with no version, and never echoes the text", () => {
    for (const text of ["", "no digits here", undefined, null, 7]) expect(parseVersion(text), String(text)).toBeUndefined();
  });
});

describe("scratch directories can hold a working directory", () => {
  it("lets a caller create a subdirectory inside the scratch root", async () => {
    await withScratchRoot("mi-test", async (root) => {
      mkdirSync(join(root, "work"), { recursive: true });
      expect(existsSync(join(root, "work"))).toBe(true);
    });
  });
});
