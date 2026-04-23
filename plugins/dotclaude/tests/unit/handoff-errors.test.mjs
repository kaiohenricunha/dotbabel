import { describe, it, expect } from "vitest";
import {
  HandoffError,
  PreflightHandledError,
  classifyGitError,
  formatHandoffError,
} from "../../src/lib/handoff-errors.mjs";

describe("PreflightHandledError", () => {
  it("is an instance of Error", () => {
    const e = new PreflightHandledError();
    expect(e).toBeInstanceOf(Error);
  });
});

describe("HandoffError", () => {
  it("is an instance of Error", () => {
    const e = new HandoffError({ stage: "upload", cause: "auth", fix: "re-auth", retry: "push" });
    expect(e).toBeInstanceOf(Error);
    expect(e.stage).toBe("upload");
    expect(e.cause).toBe("auth");
    expect(e.fix).toBe("re-auth");
    expect(e.retry).toBe("push");
  });
});

describe("classifyGitError", () => {
  it("SSH auth failure → stage upload", () => {
    const e = classifyGitError("Permission denied (publickey).", "push", {});
    expect(e.stage).toBe("upload");
    expect(e.cause).toMatch(/SSH key/i);
  });

  it("HTTP auth failure → stage upload", () => {
    const e = classifyGitError(
      "Authentication failed for 'https://github.com/me/repo.git'",
      "push",
      {},
    );
    expect(e.stage).toBe("upload");
    expect(e.cause).toMatch(/authentication/i);
  });

  it("repo not found → stage preflight", () => {
    const e = classifyGitError("ERROR: Repository not found.", "push", {});
    expect(e.stage).toBe("preflight");
    expect(e.cause).toMatch(/transport repo not found/i);
  });

  it("repo not found (gitlab phrasing) → stage preflight", () => {
    const e = classifyGitError(
      "remote: The project you were looking for could not be found",
      "push",
      {},
    );
    expect(e.stage).toBe("preflight");
  });

  it("DNS failure → stage upload", () => {
    const e = classifyGitError("Could not resolve host: github.com", "push", {});
    expect(e.stage).toBe("upload");
    expect(e.cause).toMatch(/network/i);
  });

  it("unable to access → stage upload", () => {
    const e = classifyGitError(
      "fatal: unable to access 'https://github.com/me/repo.git/': Could not resolve host",
      "push",
      {},
    );
    expect(e.stage).toBe("upload");
  });

  it("failed to push → stage upload", () => {
    const e = classifyGitError(
      "error: failed to push some refs to 'git@github.com:me/store.git'",
      "push",
      {},
    );
    expect(e.stage).toBe("upload");
    expect(e.cause).toMatch(/push rejected/i);
  });

  it("scrub not applied → stage scrub", () => {
    const e = classifyGitError("scrub not applied: scrubber binary not found", "push", {});
    expect(e.stage).toBe("scrub");
    expect(e.cause).toMatch(/scrubber/i);
  });

  it("transport not configured → stage preflight", () => {
    const e = classifyGitError("DOTCLAUDE_HANDOFF_REPO is not set — run ...", "push", {});
    expect(e.stage).toBe("preflight");
    expect(e.cause).toMatch(/transport not configured/i);
  });

  it("ls-remote failed → stage preflight", () => {
    const e = classifyGitError(
      "ls-remote failed: fatal: Could not read from remote repository",
      "fetch",
      {},
    );
    expect(e.stage).toBe("preflight");
    expect(e.cause).toMatch(/repo unreachable/i);
  });

  it("no handoffs found → stage resolve", () => {
    const e = classifyGitError("no handoffs found on transport", "fetch", {});
    expect(e.stage).toBe("resolve");
    expect(e.cause).toMatch(/no handoffs/i);
  });

  it("no handoffs match query → stage resolve", () => {
    const e = classifyGitError("no handoffs match: my-project", "fetch", { query: "my-project" });
    expect(e.stage).toBe("resolve");
  });

  it("unknown message falls back to upload stage with raw cause", () => {
    const e = classifyGitError("some completely unknown error here", "push", {});
    expect(e.stage).toBe("upload");
    expect(e.cause).toBe("some completely unknown error here");
    expect(e.fix).toMatch(/doctor/i);
  });

  it("retry line includes verb", () => {
    const e = classifyGitError("Permission denied (publickey).", "push", {});
    expect(e.retry).toMatch(/push/);
  });

  it("retry line includes query when provided", () => {
    const e = classifyGitError("no handoffs match: abc123", "fetch", { query: "abc123" });
    expect(e.retry).toMatch(/abc123/);
  });
});

describe("formatHandoffError", () => {
  it("renders all four fields to a string", () => {
    const e = new HandoffError({
      stage: "upload",
      cause: "SSH key not configured",
      fix: "Add your SSH key",
      retry: "dotclaude handoff push",
    });
    const out = formatHandoffError(e, "push");
    expect(out).toContain("dotclaude-handoff: push failed");
    expect(out).toContain("stage:  upload");
    expect(out).toContain("cause:  SSH key not configured");
    expect(out).toContain("fix:    Add your SSH key");
    expect(out).toContain("retry:  dotclaude handoff push");
  });

  it("collapses embedded newlines in cause to a single space", () => {
    const e = new HandoffError({
      stage: "upload",
      cause: "line1\nline2\nline3",
      fix: "check it",
      retry: "dotclaude handoff push",
    });
    const out = formatHandoffError(e, "push");
    expect(out).toContain("cause:  line1 line2 line3");
    expect(out.split("\n").filter((l) => l.startsWith("  cause:")).length).toBe(1);
  });
});
