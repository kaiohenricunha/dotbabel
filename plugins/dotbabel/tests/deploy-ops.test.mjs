import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  targetLabel,
} from "../../../skills/deploy-status/scripts/deploy-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const originalAdapters = { ...adapters };

afterEach(() => {
  for (const [kind, adapter] of Object.entries(originalAdapters)) {
    adapters[kind] = adapter;
  }
});

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "deploy-ops-"));
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
