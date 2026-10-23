import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const bin = fileURLToPath(new URL("../bin/dotbabel-models.mjs", import.meta.url));
function project(activation) {
  const repo = makeTempDir("mi-route-cli-");
  spawnSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, ".dotbabel.json"), JSON.stringify(activation === undefined ? {} : { model_intelligence: activation }));
  const env = { PATH: process.env.PATH, HOME: join(repo, "home"), XDG_CACHE_HOME: join(repo, "cache"), XDG_CONFIG_HOME: join(repo, "config") };
  const route = (stdin, args = []) => spawnSync(process.execPath, [bin, "route", ...args], { cwd: repo, env, input: stdin, encoding: "utf8", timeout: 60_000 });
  return { repo, route };
}
const request = (repoRoot, action, extra = {}) => JSON.stringify({ action, request: { repoRoot, prompt: "Format the sample JSON.", runtimeVersion: "2.1.309", ...extra } });

describe("dotbabel models route (persistent Claude plugin transport)", () => {
  it("answers a disabled project's activation check with a preserved decision and exit 0", () => {
    const { repo, route } = project();
    const result = route(request(repo, "activation"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).decision).toMatchObject({ status: "preserved" });
  });

  it("reports an enabled project with a verified release as ready", () => {
    const { repo, route } = project({ enabled: true, adaptive_routing: { enabled: true } });
    expect(JSON.parse(route(request(repo, "activation")).stdout)).toEqual({ ready: true });
  });

  it("keeps an unverified release preserved even in an enabled project", () => {
    const { repo, route } = project({ enabled: true, adaptive_routing: { enabled: true } });
    const body = JSON.parse(route(request(repo, "activation", { runtimeVersion: "2.1.308" })).stdout);
    expect(body.decision.status).toBe("preserved");
  });

  it("asks for native evidence instead of guessing when it has none", () => {
    const { repo, route } = project({ enabled: true, adaptive_routing: { enabled: true } });
    expect(JSON.parse(route(request(repo, "prepare", { current: { axes: {} }, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } })).stdout)).toEqual({ needsEvidence: true });
  });

  it("refuses malformed, oversized, or prompt-in-argv input with exit 64", () => {
    const { repo, route } = project();
    for (const bad of ["not json", JSON.stringify({ action: "drop", request: {} }), JSON.stringify({ action: "activation", request: { repoRoot: "relative", prompt: "", runtimeVersion: "x" } })]) {
      const result = route(bad);
      expect(result.status, bad).toBe(64);
      expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("session_input_invalid");
    }
    expect(route("x".repeat(1048577)).status).toBe(64);
    // The request travels on stdin only; no flag carries a prompt.
    expect(route(request(repo, "activation"), ["--prompt", "secret"]).status).toBe(64);
  });
});
