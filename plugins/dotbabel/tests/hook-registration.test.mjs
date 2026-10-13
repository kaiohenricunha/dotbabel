import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SHIPPED_HOOK_EVENTS,
  commandHookName,
  hookRegistrationReport,
  listShippedHooks,
  readSettingsSources,
} from "../src/hook-registration.mjs";

const HOOKS_DIR = path.resolve(import.meta.dirname, "..", "hooks");

let tmpDirs = [];
function makeTmpDir(prefix = "hook-reg-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function commandHook(command) {
  return { hooks: [{ type: "command", command }] };
}

describe("SHIPPED_HOOK_EVENTS", () => {
  it("names the expected events of exactly the hooks the package ships", () => {
    expect(Object.keys(SHIPPED_HOOK_EVENTS).sort()).toEqual(listShippedHooks(HOOKS_DIR));
  });

  it("gives every shipped hook at least one expected event", () => {
    for (const events of Object.values(SHIPPED_HOOK_EVENTS)) {
      expect(events.length).toBeGreaterThan(0);
    }
  });
});

describe("docs/hooks.md table", () => {
  it("lists exactly the shipped hooks with the events SHIPPED_HOOK_EVENTS expects", () => {
    const md = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "docs", "hooks.md"), "utf8");
    const rows = {};
    for (const line of md.split("\n")) {
      const m = /^\| `([a-z-]+\.sh)`\s*\|([^|]*)\|/.exec(line);
      if (m) rows[m[1]] = [...m[2].matchAll(/`([A-Za-z_]+)`/g)].map((x) => x[1]);
    }
    expect(Object.keys(rows).sort()).toEqual(listShippedHooks(HOOKS_DIR));
    for (const [hook, entries] of Object.entries(SHIPPED_HOOK_EVENTS)) {
      const events = [...new Set(entries.map((e) => e.split(":")[0]))];
      expect(events, hook).toEqual(rows[hook]);
    }
  });
});

describe("listShippedHooks", () => {
  it("lists only .sh files, sorted", () => {
    const dir = makeTmpDir();
    for (const name of ["b.sh", "a.sh", "README.md"]) fs.writeFileSync(path.join(dir, name), "");
    expect(listShippedHooks(dir)).toEqual(["a.sh", "b.sh"]);
  });

  it("returns an empty list for a missing directory", () => {
    expect(listShippedHooks(path.join(makeTmpDir(), "absent"))).toEqual([]);
  });
});

describe("commandHookName", () => {
  it("takes the basename of the first token, ignoring its arguments", () => {
    expect(commandHookName("$HOME/.claude/hooks/fleet-guard.sh pre-edit")).toBe("fleet-guard.sh");
  });

  it("matches a repo-local copy by basename", () => {
    expect(commandHookName(".claude/hooks/guard-destructive-git.sh")).toBe("guard-destructive-git.sh");
  });

  it("strips quotes around an expanded variable", () => {
    expect(commandHookName('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-on-write.sh')).toBe("check-on-write.sh");
  });

  it("looks past a shell interpreter and leading assignments", () => {
    expect(commandHookName("bash /opt/hooks/check-on-stop.sh")).toBe("check-on-stop.sh");
    expect(commandHookName("FOO=1 env BAR=2 /opt/hooks/check-on-stop.sh")).toBe("check-on-stop.sh");
  });

  it("returns null for an empty or non-string command", () => {
    expect(commandHookName("")).toBeNull();
    expect(commandHookName("   ")).toBeNull();
    expect(commandHookName(undefined)).toBeNull();
  });
});

describe("hookRegistrationReport", () => {
  const shippedHooks = ["check-on-write.sh", "fleet-guard.sh", "fleet-shell-prefix.sh", "guard-destructive-git.sh"];

  it("reports a hook registered for every expected event as registered", () => {
    const report = hookRegistrationReport({
      shippedHooks,
      sources: [
        {
          path: "/u/settings.json",
          settings: { hooks: { PreToolUse: [commandHook("$HOME/.claude/hooks/guard-destructive-git.sh")] } },
        },
      ],
      env: {},
    });
    expect(report.registered).toEqual([
      { hook: "guard-destructive-git.sh", events: ["PreToolUse"], missing: [], scopes: [] },
    ]);
    expect(report.unregistered.map((u) => u.hook)).toEqual([
      "check-on-write.sh",
      "fleet-guard.sh",
      "fleet-shell-prefix.sh",
    ]);
    expect(report.unregistered[0]).toEqual({ hook: "check-on-write.sh", expected: ["PostToolUse"] });
  });

  it("merges registrations across settings files", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-guard.sh"],
      sources: [
        { path: "/u/settings.json", settings: { hooks: { PreToolUse: [commandHook("x/fleet-guard.sh pre-edit")] } } },
        {
          path: "/r/.claude/settings.json",
          settings: {
            hooks: {
              PreToolUse: [commandHook("x/fleet-guard.sh pre-bash")],
              SessionStart: [commandHook("x/fleet-guard.sh session-start")],
              PostToolUse: [commandHook("x/fleet-guard.sh post-tool")],
              UserPromptSubmit: [commandHook("x/fleet-guard.sh prompt")],
            },
          },
        },
      ],
      env: {},
    });
    expect(report.registered).toEqual([
      {
        hook: "fleet-guard.sh",
        events: ["PostToolUse", "PreToolUse", "SessionStart", "UserPromptSubmit"],
        missing: [],
        scopes: [],
      },
    ]);
  });

  it("names the expected events a partly registered hook lacks", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-guard.sh"],
      sources: [
        { path: "/u/settings.json", settings: { hooks: { PreToolUse: [commandHook("x/fleet-guard.sh pre-edit")] } } },
      ],
      env: {},
    });
    expect(report.registered).toEqual([
      {
        hook: "fleet-guard.sh",
        events: ["PreToolUse"],
        missing: ["PreToolUse:pre-bash", "SessionStart:session-start", "PostToolUse:post-tool", "UserPromptSubmit:prompt"],
        scopes: [],
      },
    ]);
  });

  it("tells fleet-guard's two PreToolUse entries apart, so a missing merge-token entry shows", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-guard.sh"],
      sources: [
        {
          path: "/u/settings.json",
          settings: {
            hooks: {
              PreToolUse: [commandHook("x/fleet-guard.sh pre-edit")],
              SessionStart: [commandHook("x/fleet-guard.sh session-start")],
              PostToolUse: [commandHook("x/fleet-guard.sh post-tool")],
              UserPromptSubmit: [commandHook("x/fleet-guard.sh prompt")],
            },
          },
        },
      ],
      env: {},
    });
    expect(report.registered[0].missing).toEqual(["PreToolUse:pre-bash"]);
  });

  it("names the yolo entries a template-style registration lacks", () => {
    const entry = (arg) => commandHook(`bash "$CLAUDE_PROJECT_DIR/.claude/hooks/yolo.sh" ${arg}`);
    const report = hookRegistrationReport({
      shippedHooks: ["yolo.sh"],
      sources: [
        {
          path: "/r/.claude/settings.json",
          settings: { hooks: { UserPromptExpansion: [entry("grant")], PermissionRequest: [entry("permission")] } },
        },
      ],
      env: {},
    });
    expect(report.registered).toEqual([
      {
        hook: "yolo.sh",
        events: ["PermissionRequest", "UserPromptExpansion"],
        missing: ["SessionEnd:session-end"],
        scopes: [],
      },
    ]);
  });

  it("finds a shipped hook behind a wrapper command, a guard, or an interpreter flag", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["check-on-write.sh", "check-on-stop.sh", "guard-destructive-git.sh"],
      sources: [
        {
          path: "/u/settings.json",
          settings: {
            hooks: {
              PostToolUse: [commandHook("timeout 10 $HOME/.claude/hooks/check-on-write.sh")],
              Stop: [commandHook("test -x ~/.claude/hooks/check-on-stop.sh && ~/.claude/hooks/check-on-stop.sh")],
              PreToolUse: [commandHook("bash -o pipefail ~/.claude/hooks/guard-destructive-git.sh")],
            },
          },
        },
      ],
      env: {},
    });
    expect(report.unregistered).toEqual([]);
  });

  it("ignores a hooks key that is not an event name and reports it escaped", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["guard-destructive-git.sh"],
      sources: [
        {
          path: "/r/.claude/settings.json",
          settings: { hooks: { "PreToolUse\u001b[3A\n  ✓ fake": [commandHook("x/guard-destructive-git.sh")] } },
        },
      ],
      env: {},
    });
    expect(report.registered).toEqual([]);
    expect(report.badKeys).toEqual([{ path: "/r/.claude/settings.json", key: JSON.stringify("PreToolUse\u001b[3A\n  ✓ fake") }]);
  });

  it("names the scope of each registration", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["guard-destructive-git.sh"],
      sources: [
        { path: "/r/.claude/settings.json", scope: "project", settings: { hooks: { PreToolUse: [commandHook("x/guard-destructive-git.sh")] } } },
      ],
      env: {},
    });
    expect(report.registered[0].scopes).toEqual(["project"]);
  });

  it("counts the shell prefix from a settings env block", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-shell-prefix.sh"],
      sources: [{ path: "/u/settings.json", settings: { env: { CLAUDE_CODE_SHELL_PREFIX: "/h/fleet-shell-prefix.sh" } } }],
      env: {},
    });
    expect(report.registered).toEqual([
      { hook: "fleet-shell-prefix.sh", events: ["CLAUDE_CODE_SHELL_PREFIX"], missing: [], scopes: [] },
    ]);
  });

  it("counts the shell prefix from the process environment", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-shell-prefix.sh"],
      sources: [],
      env: { CLAUDE_CODE_SHELL_PREFIX: "/h/fleet-shell-prefix.sh" },
    });
    expect(report.registered.map((r) => r.hook)).toEqual(["fleet-shell-prefix.sh"]);
  });

  it("reads the shell prefix as one slot: the highest-precedence file wins", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-shell-prefix.sh"],
      sources: [
        { path: "/u/settings.json", scope: "user", settings: { env: { CLAUDE_CODE_SHELL_PREFIX: "/h/fleet-shell-prefix.sh" } } },
        { path: "/r/.claude/settings.local.json", scope: "local", settings: { env: { CLAUDE_CODE_SHELL_PREFIX: "/other/wrap.sh" } } },
      ],
      env: { CLAUDE_CODE_SHELL_PREFIX: "/h/fleet-shell-prefix.sh" },
    });
    expect(report.registered).toEqual([]);
    expect(report.shellPrefix).toEqual({ scope: "local", path: "/r/.claude/settings.local.json" });
  });

  it("reports which scope sets the shell prefix, so a repository's choice is visible", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-shell-prefix.sh"],
      sources: [
        { path: "/r/.claude/settings.json", scope: "project", settings: { env: { CLAUDE_CODE_SHELL_PREFIX: ".claude/hooks/fleet-shell-prefix.sh" } } },
      ],
      env: {},
    });
    expect(report.registered[0].scopes).toEqual(["project"]);
    expect(report.shellPrefix).toEqual({ scope: "project", path: "/r/.claude/settings.json" });
  });

  it("does not count a shell prefix that points at another script", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["fleet-shell-prefix.sh"],
      sources: [],
      env: { CLAUDE_CODE_SHELL_PREFIX: "/h/my-prefix.sh" },
    });
    expect(report.registered).toEqual([]);
  });

  it("ignores non-command hooks and malformed blocks", () => {
    const report = hookRegistrationReport({
      shippedHooks: ["check-on-write.sh"],
      sources: [
        {
          path: "/u/settings.json",
          settings: {
            hooks: {
              PostToolUse: [
                { hooks: [{ type: "prompt", command: "check-on-write.sh" }] },
                { hooks: "not-a-list" },
                null,
              ],
              Stop: "not-a-list",
            },
          },
        },
      ],
      env: {},
    });
    expect(report.registered).toEqual([]);
  });

  it("reports a shipped hook absent from the expected-event table with no expected events", () => {
    const report = hookRegistrationReport({ shippedHooks: ["new-hook.sh"], sources: [], env: {} });
    expect(report.unregistered).toEqual([{ hook: "new-hook.sh", expected: [] }]);
  });
});

describe("readSettingsSources", () => {
  it("reads the user, project, and local settings files that exist", () => {
    const home = makeTmpDir("home-");
    const repo = makeTmpDir("repo-");
    writeJson(path.join(home, ".claude", "settings.json"), { hooks: {} });
    writeJson(path.join(repo, ".claude", "settings.local.json"), { env: {} });

    const { sources, errors } = readSettingsSources({ home, repoRoot: repo, env: {} });

    expect(errors).toEqual([]);
    expect(sources.map((s) => s.path)).toEqual([
      path.join(home, ".claude", "settings.json"),
      path.join(repo, ".claude", "settings.local.json"),
    ]);
  });

  it("honors CLAUDE_CONFIG_DIR for the user settings file", () => {
    const home = makeTmpDir("home-");
    const configDir = makeTmpDir("cfg-");
    writeJson(path.join(configDir, "settings.json"), { hooks: {} });

    const { sources } = readSettingsSources({
      home,
      repoRoot: makeTmpDir("repo-"),
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    expect(sources.map((s) => s.path)).toEqual([path.join(configDir, "settings.json")]);
  });

  it("tags each source with its scope and strips control characters from a parse error", () => {
    const home = makeTmpDir("home-");
    const repo = makeTmpDir("repo-");
    writeJson(path.join(home, ".claude", "settings.json"), {});
    writeJson(path.join(repo, ".claude", "settings.json"), {});
    writeJson(path.join(repo, ".claude", "settings.local.json"), "{\u001b[2J broken");
    const { sources, errors } = readSettingsSources({ home, repoRoot: repo, env: {} });
    expect(sources.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("reports an unparseable or non-object file by name and keeps the others", () => {
    const home = makeTmpDir("home-");
    const repo = makeTmpDir("repo-");
    writeJson(path.join(home, ".claude", "settings.json"), "{ not json");
    writeJson(path.join(repo, ".claude", "settings.json"), "[1, 2]");
    writeJson(path.join(repo, ".claude", "settings.local.json"), { hooks: {} });

    const { sources, errors } = readSettingsSources({ home, repoRoot: repo, env: {} });

    expect(sources.map((s) => s.path)).toEqual([path.join(repo, ".claude", "settings.local.json")]);
    expect(errors.map((e) => e.path)).toEqual([
      path.join(home, ".claude", "settings.json"),
      path.join(repo, ".claude", "settings.json"),
    ]);
    expect(errors[1].message).toMatch(/not a JSON object/);
  });
});
