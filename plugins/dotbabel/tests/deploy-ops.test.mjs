import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adapters,
  buildRollbackGroups,
  compareToMain,
  extractSha,
  formatAge,
  parseFlyApp,
  resolveTargets,
  rollbackReport,
  smokeBackoffSchedule,
  smokeReport,
  targetLabel,
} from "../../../skills/deploy-status/scripts/deploy-ops.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const originalAdapters = { ...adapters };

afterEach(() => {
  for (const [kind, adapter] of Object.entries(originalAdapters)) {
    adapters[kind] = adapter;
  }
});

function tempRoot() {
  return makeTempDir("deploy-ops-");
}

function writeJson(root, rel, value) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(root, rel, value) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, value);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe("deploy target discovery", () => {
  it("discovers Vercel and Fly targets without config", () => {
    const root = tempRoot();
    writeJson(root, ".vercel/project.json", {
      projectId: "prj_123",
      orgId: "team_456",
      projectName: "squadranks",
    });
    writeText(root, "fly.toml", 'app = "wc-squad-rankings-api"\nprimary_region = "gru"\n');

    const resolved = resolveTargets(root);

    expect(resolved.targets.map(targetLabel)).toEqual([
      "vercel/squadranks",
      "fly/wc-squad-rankings-api",
    ]);
    expect(resolved.targets[0]).toMatchObject({
      kind: "vercel",
      project: "squadranks",
      projectId: "prj_123",
      orgId: "team_456",
      source: "auto",
    });
  });

  it("merges configured targets over auto-discovered targets and preserves rollback_order", () => {
    const root = tempRoot();
    writeJson(root, ".vercel/project.json", {
      projectId: "prj_123",
      projectName: "web",
    });
    writeText(root, "fly.toml", 'app = "api"\n');
    writeJson(root, ".claude/deploy-targets.json", {
      targets: [
        { kind: "vercel", projectId: "prj_123", project: "web", scope: "my-team" },
        { kind: "aws-amplify", appId: "d123", region: "us-east-1" },
      ],
      rollback_order: ["fly", "vercel"],
    });

    const resolved = resolveTargets(root);

    expect(resolved.rollbackOrder).toEqual(["fly", "vercel"]);
    expect(resolved.targets.map((target) => target.kind)).toEqual(["vercel", "fly", "aws-amplify"]);
    expect(resolved.targets[0]).toMatchObject({ source: "config", scope: "my-team" });
  });

  it("parses the top-level Fly app from fly.toml", () => {
    expect(parseFlyApp("# comment\napp = 'api-prod' # trailing\n[env]\nAPP = 'not-this'")).toBe(
      "api-prod",
    );
  });
});

describe("deploy drift helpers", () => {
  it("extracts git SHAs from preferred metadata keys before fallback strings", () => {
    expect(
      extractSha({
        id: "1234567",
        meta: { githubCommitSha: "abcdef1234567890abcdef1234567890abcdef12" },
      }),
    ).toBe("abcdef1234567890abcdef1234567890abcdef12");
  });

  it("reports commits behind origin/main", () => {
    const root = tempRoot();
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    writeText(root, "README.md", "one\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "one"]);
    const deployed = git(root, ["rev-parse", "HEAD"]);
    writeText(root, "README.md", "two\n");
    git(root, ["commit", "-am", "two"]);
    const main = git(root, ["rev-parse", "HEAD"]);

    expect(compareToMain(deployed, main, root)).toMatchObject({
      text: "1 commit behind",
      drift: true,
      unknown: false,
    });
  });

  it("formats recent and old deployment ages", () => {
    const now = Date.parse("2026-05-05T12:00:00Z");
    expect(formatAge("2026-05-05T10:46:00Z", now)).toBe("1h 14m");
    expect(formatAge("2026-05-03T10:00:00Z", now)).toBe("2d 2h");
  });
});

describe("rollback orchestration", () => {
  it("groups rollback targets according to rollback_order", () => {
    const vercel = { kind: "vercel", project: "web", id: "vercel/web" };
    const fly = { kind: "fly", app: "api", id: "fly/api" };
    const other = { kind: "vercel", project: "admin", id: "vercel/admin" };

    expect(buildRollbackGroups([vercel, fly, other], ["fly", "vercel"])).toEqual([
      [fly],
      [vercel, other],
    ]);
  });

  it("does not run rollback actions when confirmation is declined", async () => {
    let rollbackCalls = 0;
    adapters.vercel = {
      auth() {},
      releases(target) {
        return [
          {
            target,
            sha: "bbbbbbb",
            deployedAt: "2026-05-05T12:00:00Z",
            deployer: "now@example.com",
          },
          {
            target,
            sha: "aaaaaaa",
            deployedAt: "2026-05-05T11:00:00Z",
            deployer: "prev@example.com",
            rollbackRef: "dpl_prev",
          },
        ];
      },
      async rollback() {
        rollbackCalls++;
      },
    };

    const report = await rollbackReport({
      root: REPO_ROOT,
      targets: [{ kind: "vercel", project: "web", id: "vercel/web" }],
      rollbackOrder: [],
      confirm: async () => false,
    });

    expect(report.exitCode).toBe(1);
    expect(report.text).toContain("Confirmation declined");
    expect(rollbackCalls).toBe(0);
  });

  it("dry-run prints the rollback plan without confirmation", async () => {
    adapters.fly = {
      auth() {},
      releases(target) {
        return [
          { target, sha: "2222222", deployedAt: "2026-05-05T12:00:00Z" },
          { target, sha: "1111111", deployedAt: "2026-05-05T10:00:00Z", image: "registry/app:old" },
        ];
      },
      async rollback() {
        throw new Error("should not run");
      },
    };

    const report = await rollbackReport({
      root: REPO_ROOT,
      targets: [{ kind: "fly", app: "api", id: "fly/api" }],
      rollbackOrder: ["fly"],
      dryRun: true,
      confirm: async () => {
        throw new Error("should not prompt");
      },
    });

    expect(report.exitCode).toBe(0);
    expect(report.text).toContain("fly/api");
    expect(report.text).toContain("Dry run: no rollback actions were run.");
  });
});

// --- P-E1: smoke checks (KD-13, SEC-8, PERF-6, REL-8) ----------------------
//
// These checks run against PRODUCTION immediately after a deploy, which makes
// them the one place in this repo where an outbound request carries a real
// secret. SEC-8 is therefore asserted as behavior, not documented as intent:
// a credential in a URL, a downgrade to http, a redirect to another origin,
// and a header value reaching stdout are each a leak, and each has a test.
//
// The helper is deliberately self-contained (KD-13) because scaffolded copies
// have no package source to import, so every guard below lives in the one file
// and is verified through its exported surface.

describe("smoke checks", () => {
  const target = (smoke) => ({ kind: "fly", app: "api", id: "fly/api", smoke });

  // A fetch stub recording every call, so redirect and header behavior can be
  // asserted on what was actually SENT rather than on what was returned.
  function stubFetch(responses) {
    const calls = [];
    const queue = Array.isArray(responses) ? [...responses] : [responses];
    const fn = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return {
        status: next.status ?? 200,
        headers: { get: (name) => (next.headers ?? {})[String(name).toLowerCase()] ?? null },
        text: async () => next.body ?? "",
      };
    };
    fn.calls = calls;
    return fn;
  }

  it("smoke: passes an http check that returns the expected status and body text", async () => {
    const fetch = stubFetch({ status: 200, body: "service ok" });
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200, expect_text: "ok" }])],
      deps: { fetch, sleep: async () => {} },
    });
    expect(report.exitCode).toBe(0);
    expect(report.results[0]).toMatchObject({ ok: true, status: 200 });
    expect(fetch.calls[0].init.method).toBe("GET");
  });

  it("smoke: retries an http GET check 3 times with 2, 4, and 8 second backoff", async () => {
    const fetch = stubFetch({ status: 503, body: "down" });
    const slept = [];
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch, sleep: async (ms) => { slept.push(ms); } },
    });
    // PERF-6: 4 attempts total — the first plus 3 retries — and the waits
    // between them double. A fixed delay would hammer a service that is
    // already failing.
    expect(fetch.calls).toHaveLength(4);
    expect(slept).toEqual([2000, 4000, 8000]);
    expect(report.exitCode).toBe(1);
  });

  it("smoke: runs a command check exactly once", async () => {
    // REL-8: only GET retries. A command may not be idempotent, so retrying
    // one could repeat a side effect the author never agreed to.
    let runs = 0;
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "command", argv: ["true"] }])],
      deps: { runCommand: () => { runs += 1; return { ok: false, status: 1, stdout: "", stderr: "boom" }; }, sleep: async () => {} },
    });
    expect(runs).toBe(1);
    expect(report.exitCode).toBe(1);
  });

  it("smoke: runs a real command through the default runner, with nothing injected", async () => {
    // Every other command test injects deps.runCommand, so none of them ever
    // executed the DEFAULT path — which referenced an undefined function and
    // crashed the CLI on the first real run. A stub that stands in for the
    // code under test cannot catch a bug in the code it replaced.
    const pass = await smokeReport({
      root: REPO_ROOT,
      targets: [target([{ type: "command", argv: ["node", "-e", "process.exit(0)"] }])],
      deps: { sleep: async () => {} },
    });
    expect(pass.exitCode).toBe(0);
    expect(pass.results[0]).toMatchObject({ type: "command", ok: true, attempts: 1 });

    const fail = await smokeReport({
      root: REPO_ROOT,
      targets: [target([{ type: "command", argv: ["node", "-e", "process.exit(3)"] }])],
      deps: { sleep: async () => {} },
    });
    expect(fail.exitCode).toBe(1);
    expect(fail.results[0]).toMatchObject({ ok: false, status: 3 });
  });

  it("smoke: rejects a URL with embedded credentials", async () => {
    const fetch = stubFetch({ status: 200 });
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://user:pass@example.test/health" }])],
      deps: { fetch, sleep: async () => {} },
    });
    expect(report.exitCode).toBe(1);
    expect(fetch.calls, "a rejected URL must never be requested").toHaveLength(0);
    expect(JSON.stringify(report.results[0])).not.toContain("pass");
  });

  it("smoke: rejects a non-https URL for any host except localhost and 127.0.0.1", async () => {
    const fetch = stubFetch({ status: 200 });
    const remote = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "http://example.test/health" }])],
      deps: { fetch, sleep: async () => {} },
    });
    expect(remote.exitCode).toBe(1);
    expect(fetch.calls).toHaveLength(0);

    // Loopback over http is the documented exception: a local smoke check
    // has no TLS to offer and no network to be intercepted on.
    for (const host of ["localhost", "127.0.0.1"]) {
      const local = await smokeReport({
        root: ".",
        targets: [target([{ type: "http", url: `http://${host}:8080/health`, expect_status: 200 }])],
        deps: { fetch: stubFetch({ status: 200 }), sleep: async () => {} },
      });
      expect(local.exitCode, `${host} must be allowed over http`).toBe(0);
    }
  });

  it("smoke: never follows a redirect to a different origin or to http", async () => {
    // Redirects are followed MANUALLY (SEC-8): handing `redirect: "follow"` to
    // fetch would re-send the secret header to wherever the response pointed.
    const crossOrigin = stubFetch([
      { status: 302, headers: { location: "https://evil.test/health" } },
      { status: 200, body: "ok" },
    ]);
    const a = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch: crossOrigin, sleep: async () => {} },
    });
    expect(a.exitCode).toBe(1);
    expect(crossOrigin.calls, "must not request the other origin").toHaveLength(1);
    expect(crossOrigin.calls[0].init.redirect).toBe("manual");

    const downgrade = stubFetch([
      { status: 302, headers: { location: "http://example.test/health" } },
      { status: 200, body: "ok" },
    ]);
    const b = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch: downgrade, sleep: async () => {} },
    });
    expect(b.exitCode).toBe(1);
    expect(downgrade.calls).toHaveLength(1);

    // Same https origin is followed.
    const same = stubFetch([
      { status: 302, headers: { location: "https://example.test/healthz" } },
      { status: 200, body: "ok" },
    ]);
    const c = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch: same, sleep: async () => {} },
    });
    expect(c.exitCode).toBe(0);
    expect(same.calls).toHaveLength(2);
  });

  it("smoke: reads a secret header only from the named environment variable", async () => {
    const fetch = stubFetch({ status: 200, body: "ok" });
    const report = await smokeReport({
      root: ".",
      targets: [target([{
        type: "http",
        url: "https://example.test/health",
        expect_status: 200,
        headers: { Authorization: { env: "SMOKE_TOKEN" } },
      }])],
      deps: { fetch, sleep: async () => {}, env: { SMOKE_TOKEN: "s3cret-value" } },
    });
    expect(report.exitCode).toBe(0);
    expect(fetch.calls[0].init.headers.Authorization).toBe("s3cret-value");

    // A literal value in the config is refused: config is committed, and a
    // secret in a committed file is a leak no redaction can undo.
    const literal = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", headers: { Authorization: "Bearer hardcoded" } }])],
      deps: { fetch: stubFetch({ status: 200 }), sleep: async () => {}, env: {} },
    });
    expect(literal.exitCode).toBe(1);

    // A missing variable fails the check rather than sending no header and
    // reporting a pass on an unauthenticated response.
    const missing = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", headers: { Authorization: { env: "ABSENT_VAR" } } }])],
      deps: { fetch: stubFetch({ status: 200 }), sleep: async () => {}, env: {} },
    });
    expect(missing.exitCode).toBe(1);
  });

  it("smoke: never prints a header value read from the environment", async () => {
    const fetch = stubFetch({ status: 500, body: "s3cret-value leaked into the body" });
    const report = await smokeReport({
      root: ".",
      targets: [target([{
        type: "http",
        url: "https://example.test/health",
        expect_status: 200,
        headers: { Authorization: { env: "SMOKE_TOKEN" } },
      }])],
      deps: { fetch, sleep: async () => {}, env: { SMOKE_TOKEN: "s3cret-value" } },
    });
    // Neither the rendered text nor the JSON payload may carry the value —
    // including when the SERVER echoes it back in a failing response body.
    expect(report.text).not.toContain("s3cret-value");
    expect(JSON.stringify(report.json)).not.toContain("s3cret-value");
    expect(report.text).toContain("Authorization");
  });

  it("smoke: exits 0 with a notice when no target declares smoke checks", async () => {
    // Nothing to check is not a failure. Exiting non-zero here would make
    // `release-conductor verify` block every release that has no smoke config.
    const report = await smokeReport({ root: ".", targets: [target(undefined)], deps: { sleep: async () => {} } });
    expect(report.exitCode).toBe(0);
    expect(report.text).toMatch(/no smoke checks/i);
  });

  it("smoke: exits 1 when any smoke check fails", async () => {
    const fetch = stubFetch([{ status: 200, body: "ok" }, { status: 500, body: "bad" }]);
    const report = await smokeReport({
      root: ".",
      targets: [target([
        { type: "http", url: "https://example.test/a", expect_status: 200 },
        { type: "http", url: "https://example.test/b", expect_status: 200 },
      ])],
      deps: { fetch, sleep: async () => {} },
    });
    expect(report.exitCode).toBe(1);
  });

  it("smoke: stops the whole run after 300 seconds", async () => {
    // PERF-6 total bound. Without it, a target with many slow checks could
    // hold a release open indefinitely. A fake clock keeps the test instant.
    let clock = 0;
    const fetch = stubFetch({ status: 500, body: "down" });
    const checks = Array.from({ length: 50 }, (_, i) => ({ type: "http", url: `https://example.test/${i}`, expect_status: 200 }));
    const report = await smokeReport({
      root: ".",
      targets: [target(checks)],
      deps: { fetch, sleep: async (ms) => { clock += ms; }, now: () => clock },
    });
    expect(report.exitCode).toBe(1);
    expect(report.text).toMatch(/budget|300/i);
    // It must stop early, not run all 50 checks past the budget.
    expect(report.results.length).toBeLessThan(checks.length);
  });

  it("smoke: prints JSON that validates against the smoke report schema", async () => {
    const schema = JSON.parse(fs.readFileSync(join(REPO_ROOT, "schemas", "dotbabel.smoke-report.schema.json"), "utf8"));
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch: stubFetch({ status: 200, body: "ok" }), sleep: async () => {} },
    });
    // Asserted against the shipped schema's own required/enum lists, so the
    // schema cannot drift away from the payload without failing here.
    for (const key of schema.required) expect(report.json, `missing ${key}`).toHaveProperty(key);
    expect(schema.properties.schema_version.const).toBe(report.json.schema_version);
    expect(schema.properties.verdict.enum).toContain(report.json.verdict);
    for (const result of report.json.results) {
      for (const key of schema.properties.results.items.required) expect(result).toHaveProperty(key);
    }
  });

  it("smoke: reports which expectation failed, not the one that matched", async () => {
    // Caught during simplification: collapsing status/body comparison into a
    // single boolean lost which half failed, so a status-matches-but-body-
    // mismatch case reported the self-contradicting "expected status 200, got
    // 200". The message must name the expectation that actually failed.
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200, expect_text: "ready" }])],
      deps: { fetch: stubFetch({ status: 200, body: "unexpected body" }), sleep: async () => {} },
    });
    expect(report.results[0].message).toContain("body did not contain");
    expect(report.results[0].message).not.toMatch(/expected status \d+, got \d+/);
  });

  it("smoke: aborts a request that never responds, and retries it as transient", async () => {
    // `timeoutMs` is not a fetch option — unknown init keys are ignored, so the
    // declared PERF-6 bound did not exist. Verified against a real server that
    // accepts the connection and never answers: still hanging after 6s.
    // The stub here rejects only when the signal fires, so a request that is
    // never aborted hangs this test rather than passing it.
    let sawSignal = 0;
    const fetch = async (_url, init) => {
      sawSignal += init?.signal ? 1 : 0;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    };
    const report = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { fetch, sleep: async () => {}, requestTimeoutMs: 20 },
    });
    expect(sawSignal).toBeGreaterThan(0);
    expect(report.exitCode).toBe(1);
    // A timeout is transient, not a config refusal, so it uses the full retry
    // budget rather than failing fatally on the first attempt.
    expect(report.results[0].attempts).toBe(4);
    expect(report.results[0].message).toMatch(/abort|timeout|timed out/i);
  });

  it("smoke: never echoes a credentialed URL, even when header resolution fails first", async () => {
    // Header resolution ran BEFORE URL validation, and its failure branch
    // echoed the raw URL — so the no-echo rule held on one branch and broke on
    // its sibling. An unset env var is the likeliest first-run failure, which
    // made this the probable path rather than an exotic one.
    for (const headers of [{ Authorization: { env: "ABSENT_VAR" } }, { Authorization: "Bearer literal" }]) {
      const report = await smokeReport({
        root: ".",
        targets: [target([{ type: "http", url: "https://user:pa55w0rd@api.example.test/me", headers }])],
        deps: { fetch: stubFetch({ status: 200 }), sleep: async () => {}, env: {} },
      });
      expect(report.exitCode).toBe(1);
      expect(report.text, "password must not reach stdout").not.toContain("pa55w0rd");
      expect(JSON.stringify(report.json), "password must not reach the payload").not.toContain("pa55w0rd");
    }
  });

  it("smoke: fails a check with no declared expectation when the response is not 2xx", async () => {
    // `ok` from an attempt means "a response arrived", not "the response was
    // good". With neither expectation declared the check used to pass on a
    // hard 500 — a release gate turning an outage green, via the simplest
    // config anyone would write first.
    const bad = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health" }])],
      deps: { fetch: stubFetch({ status: 500, body: "INTERNAL ERROR" }), sleep: async () => {} },
    });
    expect(bad.exitCode).toBe(1);

    // A 2xx with no declared expectation still passes: the default is "2xx",
    // not "must declare expectations".
    const good = await smokeReport({
      root: ".",
      targets: [target([{ type: "http", url: "https://example.test/health" }])],
      deps: { fetch: stubFetch({ status: 204 }), sleep: async () => {} },
    });
    expect(good.exitCode).toBe(0);
  });

  it("smoke: marks a dry run in the payload and does not report it as a pass", async () => {
    const schema = JSON.parse(fs.readFileSync(join(REPO_ROOT, "schemas", "dotbabel.smoke-report.schema.json"), "utf8"));
    const report = await smokeReport({
      root: ".", dryRun: true,
      targets: [target([{ type: "http", url: "https://example.test/health", expect_status: 200 }])],
      deps: { sleep: async () => {} },
    });
    // A machine consumer must be able to tell "nothing ran" from "everything
    // passed": a stray --dry-run in a pipeline would otherwise green-light a
    // production gate over zero executed checks.
    expect(report.json.dry_run).toBe(true);
    expect(report.json.verdict).not.toBe("pass");
    expect(schema.properties.verdict.enum).toContain(report.json.verdict);
    // And the payload must satisfy the schema it ships with.
    const min = schema.properties.results.items.properties.attempts.minimum;
    for (const result of report.json.results) expect(result.attempts).toBeGreaterThanOrEqual(min);
  });

  it("smoke: computes the backoff schedule for any retry count from 0 through 10", () => {
    // Property sweep rather than three fixed cases: the schedule is arithmetic,
    // so an off-by-one shows up at a boundary the examples happen to skip.
    for (let retries = 0; retries <= 10; retries += 1) {
      const schedule = smokeBackoffSchedule(retries);
      expect(schedule).toHaveLength(retries);
      schedule.forEach((delay, index) => {
        expect(delay).toBe(2000 * 2 ** index);
        if (index > 0) expect(delay).toBe(schedule[index - 1] * 2);
      });
    }
    expect(smokeBackoffSchedule(3)).toEqual([2000, 4000, 8000]);
  });
});
