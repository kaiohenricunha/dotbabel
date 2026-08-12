import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  grantCheckOnStopTrust,
  isRepoTrusted,
  resolveTrustFilePath,
} from "../src/trust-allowlist.mjs";
import { ERROR_CODES, ValidationError } from "../src/lib/errors.mjs";

const tmpDirs = [];

function mkTmp(prefix = "trust-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A repo dir plus an allowlist path inside a separate temp dir. */
function fixture() {
  const repo = mkTmp("trust-repo-");
  const cfg = mkTmp("trust-cfg-");
  const trustFile = path.join(cfg, "check-on-stop-trusted");
  return { repo, cfg, trustFile, env: { CHECK_ON_STOP_TRUSTED_FILE: trustFile } };
}

/** Non-comment, non-blank lines — what the hook would actually consider. */
function entriesOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe("resolveTrustFilePath", () => {
  // These three pin the precedence in check-on-stop.sh. If the writer and the
  // hook ever disagree about which file to use, a grant silently does nothing.
  it("honors CHECK_ON_STOP_TRUSTED_FILE above everything", () => {
    const got = resolveTrustFilePath({
      CHECK_ON_STOP_TRUSTED_FILE: "/explicit/file",
      XDG_CONFIG_HOME: "/xdg",
      HOME: "/home/u",
    });
    expect(got).toBe("/explicit/file");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    const got = resolveTrustFilePath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" });
    expect(got).toBe("/xdg/dotbabel/check-on-stop-trusted");
  });

  it("falls back to HOME/.config when XDG_CONFIG_HOME is unset", () => {
    const got = resolveTrustFilePath({ HOME: "/home/u" });
    expect(got).toBe("/home/u/.config/dotbabel/check-on-stop-trusted");
  });
});

describe("grantCheckOnStopTrust", () => {
  it("creates the file with a header and records the repo", () => {
    const { repo, trustFile, env } = fixture();
    const res = grantCheckOnStopTrust({ repoRoot: repo, env });

    expect(res.action).toBe("added");
    expect(res.createdFile).toBe(true);
    expect(res.entry).toBe(fs.realpathSync(repo));

    const text = fs.readFileSync(trustFile, "utf8");
    expect(text).toMatch(/^# dotbabel check-on-stop trust allowlist/);
    expect(text).toMatch(/Revoke: delete the line/);
    expect(entriesOf(trustFile)).toEqual([fs.realpathSync(repo)]);
  });

  it("is idempotent", () => {
    const { repo, trustFile, env } = fixture();
    grantCheckOnStopTrust({ repoRoot: repo, env });
    const second = grantCheckOnStopTrust({ repoRoot: repo, env });

    expect(second.action).toBe("already-present");
    expect(second.createdFile).toBe(false);
    expect(entriesOf(trustFile)).toHaveLength(1);
  });

  it("records the resolved path, and dedupes across a symlink alias", () => {
    // The regression that matters: check-on-stop.sh compares `cd && pwd -P`
    // output. Recording the symlink instead would still match, but a later
    // grant via the real path would append a duplicate, and the grant would
    // follow the symlink if it were ever repointed at another checkout.
    const { trustFile, env } = fixture();
    const real = mkTmp("trust-real-");
    const linkParent = mkTmp("trust-link-");
    const link = path.join(linkParent, "alias");
    fs.symlinkSync(real, link);

    const viaLink = grantCheckOnStopTrust({ repoRoot: link, env });
    expect(viaLink.action).toBe("added");
    expect(viaLink.entry).toBe(fs.realpathSync(real));
    expect(entriesOf(trustFile)).toEqual([fs.realpathSync(real)]);

    const viaReal = grantCheckOnStopTrust({ repoRoot: real, env });
    expect(viaReal.action).toBe("already-present");
    expect(entriesOf(trustFile)).toHaveLength(1);
  });

  it("repairs a file with no trailing newline instead of corrupting it", () => {
    // Without the fixup the append lands on the previous line, producing
    // "/existing/path/new/path" — which resolves to nothing, so BOTH entries
    // die silently and the user's turn-end checks just go quiet.
    const { repo, trustFile, env } = fixture();
    fs.writeFileSync(trustFile, "/some/existing/path", "utf8");

    grantCheckOnStopTrust({ repoRoot: repo, env });

    expect(entriesOf(trustFile)).toEqual(["/some/existing/path", fs.realpathSync(repo)]);
  });

  it("ignores blank lines and comments when checking for duplicates", () => {
    const { repo, trustFile, env } = fixture();
    fs.writeFileSync(trustFile, `# a comment\n\n${fs.realpathSync(repo)}\n`, "utf8");

    const res = grantCheckOnStopTrust({ repoRoot: repo, env });

    expect(res.action).toBe("already-present");
    expect(entriesOf(trustFile)).toHaveLength(1);
  });

  it("matches an entry whose directory no longer exists, by raw equality", () => {
    // Resolve-only dedupe would miss this and append a byte-identical line.
    const { trustFile, env } = fixture();
    const doomed = mkTmp("trust-doomed-");
    const resolved = fs.realpathSync(doomed);
    fs.writeFileSync(trustFile, `${resolved}\n`, "utf8");
    fs.rmSync(doomed, { recursive: true, force: true });

    // Re-create it so realpath of the *argument* still works, then confirm the
    // stale line is matched rather than duplicated.
    fs.mkdirSync(resolved, { recursive: true });
    const res = grantCheckOnStopTrust({ repoRoot: resolved, env });

    expect(res.action).toBe("already-present");
    expect(entriesOf(trustFile)).toHaveLength(1);
  });

  it("dry-run reports would-add and writes nothing", () => {
    const { repo, trustFile, env } = fixture();
    const res = grantCheckOnStopTrust({ repoRoot: repo, env, dryRun: true });

    expect(res.action).toBe("would-add");
    expect(fs.existsSync(trustFile)).toBe(false);
  });

  it("dry-run still reports already-present accurately", () => {
    const { repo, trustFile, env } = fixture();
    grantCheckOnStopTrust({ repoRoot: repo, env });
    const before = fs.readFileSync(trustFile, "utf8");

    const res = grantCheckOnStopTrust({ repoRoot: repo, env, dryRun: true });

    expect(res.action).toBe("already-present");
    expect(fs.readFileSync(trustFile, "utf8")).toBe(before);
  });

  it.skipIf(process.platform === "win32")("creates dir and file with private modes", () => {
    // This file is a capability list. A group- or world-writable one lets any
    // local user grant themselves turn-end code execution in these repos.
    const repo = mkTmp("trust-repo-");
    const cfgParent = mkTmp("trust-cfgp-");
    const trustFile = path.join(cfgParent, "nested", "check-on-stop-trusted");
    grantCheckOnStopTrust({ repoRoot: repo, env: { CHECK_ON_STOP_TRUSTED_FILE: trustFile } });

    expect(fs.statSync(path.dirname(trustFile)).mode & 0o077).toBe(0);
    expect(fs.statSync(trustFile).mode & 0o077).toBe(0);
  });

  it("refuses a path containing a newline", () => {
    // Linux permits newlines in directory names, so a crafted --repo would
    // otherwise append a SECOND entry naming a directory nobody chose.
    const { env } = fixture();
    const parent = mkTmp("trust-nl-");
    const nasty = path.join(parent, "a\nb");
    fs.mkdirSync(nasty);

    try {
      grantCheckOnStopTrust({ repoRoot: nasty, env });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.TRUST_WRITE_FAILED);
    }
  });

  it("throws TRUST_WRITE_FAILED when the path cannot be resolved", () => {
    const { env } = fixture();
    try {
      grantCheckOnStopTrust({ repoRoot: "/nonexistent/repo/xyz", env });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.TRUST_WRITE_FAILED);
    }
  });

  it("throws TRUST_WRITE_FAILED when the allowlist cannot be created", () => {
    // ENOTDIR via a regular file in the parent position. Chosen over
    // chmod 0o500 because CI often runs as root, which ignores mode bits —
    // the test would silently stop throwing and leave this branch uncovered.
    const repo = mkTmp("trust-repo-");
    const parent = mkTmp("trust-notdir-");
    const blocker = path.join(parent, "afile");
    fs.writeFileSync(blocker, "not a directory", "utf8");

    try {
      grantCheckOnStopTrust({
        repoRoot: repo,
        env: { CHECK_ON_STOP_TRUSTED_FILE: path.join(blocker, "trusted") },
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.TRUST_WRITE_FAILED);
    }
  });
});

describe("isRepoTrusted", () => {
  it("is true for a granted repo and reports the matched entry", () => {
    const { repo, env } = fixture();
    grantCheckOnStopTrust({ repoRoot: repo, env });

    const res = isRepoTrusted({ repoRoot: repo, env });
    expect(res.trusted).toBe(true);
    expect(res.matchedEntry).toBe(fs.realpathSync(repo));
    expect(res.trustAll).toBe(false);
  });

  it("is false for a repo that was never granted", () => {
    const { repo, trustFile, env } = fixture();
    fs.writeFileSync(trustFile, "/some/other/repo\n", "utf8");

    const res = isRepoTrusted({ repoRoot: repo, env });
    expect(res.trusted).toBe(false);
    expect(res.fileExists).toBe(true);
  });

  it("does not trust a shared-prefix sibling", () => {
    // A trusted /srv/app must never confer trust on /srv/app-untrusted.
    const { trustFile, env } = fixture();
    const parent = mkTmp("trust-sib-");
    const app = path.join(parent, "app");
    const sibling = path.join(parent, "app-untrusted");
    fs.mkdirSync(app);
    fs.mkdirSync(sibling);
    fs.writeFileSync(trustFile, `${fs.realpathSync(app)}\n`, "utf8");

    expect(isRepoTrusted({ repoRoot: app, env }).trusted).toBe(true);
    expect(isRepoTrusted({ repoRoot: sibling, env }).trusted).toBe(false);
  });

  it("is false when no allowlist exists", () => {
    const { repo, env } = fixture();
    const res = isRepoTrusted({ repoRoot: repo, env });
    expect(res.trusted).toBe(false);
    expect(res.fileExists).toBe(false);
  });

  it("reports trustAll when CHECK_ON_STOP_TRUST_ALL=1", () => {
    const { repo, env } = fixture();
    const res = isRepoTrusted({
      repoRoot: repo,
      env: { ...env, CHECK_ON_STOP_TRUST_ALL: "1" },
    });
    expect(res.trusted).toBe(true);
    expect(res.trustAll).toBe(true);
  });

  it("never throws when the repo path is gone", () => {
    const { trustFile, env } = fixture();
    fs.writeFileSync(trustFile, "/some/path\n", "utf8");
    const res = isRepoTrusted({ repoRoot: "/nonexistent/xyz", env });
    expect(res.trusted).toBe(false);
    expect(res.readError).toBeTruthy();
  });
});
