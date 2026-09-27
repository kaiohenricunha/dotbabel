// End-to-end tests for the CPU-lane commands of bin/dotbabel-fleet.mjs:
// `lane-check` (the detector the shell prefix calls), `lane` (run a command in
// a lane), and `lanes` (show who holds each lane).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const CHECK = path.resolve(__dirname, "../scripts/fleet-lane-check.mjs");
const NODE = process.execPath;
const HAS_TOOLS = ["flock", "taskset"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

function env(state, extra = {}) {
  const e = { ...process.env, DOTBABEL_FLEET_STATE_DIR: state, ...extra };
  for (const k of ["DOTBABEL_FLEET_LANES", "DOTBABEL_FLEET_LANE_COUNT", "DOTBABEL_FLEET_NCPU", "DOTBABEL_LANE"]) {
    if (!(k in extra)) delete e[k];
  }
  return e;
}

function fleet(args, { state = makeTempDir("fleet-lane-cli-"), input, extra } = {}) {
  return spawnSync(NODE, [BIN, ...args], { env: env(state, extra), input, encoding: "utf8" });
}

describe("scripts/fleet-lane-check.mjs", () => {
  const check = (input) => spawnSync(NODE, [CHECK], { input, encoding: "utf8" });

  it("prints the label of a heavy command and exits 0", () => {
    const r = check("cd api && npm test -- --coverage");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("npm test\n");
  });

  it("exits 1 with no output for a light command", () => {
    const r = check("git status && npm install");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe.skipIf(!HAS_TOOLS)("dotbabel-fleet lane", () => {
  it("runs the command pinned to a lane", () => {
    const r = fleet(["lane", "--", NODE, "-e", "console.log(require('os').availableParallelism())"], {
      extra: { DOTBABEL_FLEET_LANES: "0" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("1");
  });

  it("passes the command's own flags and exit status through", () => {
    const r = fleet(["lane", "--", NODE, "-e", "process.exit(Number(process.argv[1]))", "7"], {
      extra: { DOTBABEL_FLEET_LANES: "0" },
    });
    expect(r.status).toBe(7);
  });

  it("shows the holder of a busy lane, and frees the lane when the command ends", async () => {
    const state = makeTempDir("fleet-lane-cli-");
    const extra = { DOTBABEL_FLEET_LANES: "0" };
    // The job holds its lane until the test creates `release`, so a slow
    // machine cannot end it between the checks (capped at 30 s).
    const release = path.join(state, "release");
    const hold = `const f=process.argv[1],t=Date.now();const i=setInterval(()=>{if(require("fs").existsSync(f)||Date.now()-t>30000)clearInterval(i)},25)`;
    const job = spawn(NODE, [BIN, "lane", "--name", "npm test", "--", NODE, "-e", hold, release], {
      env: env(state, extra),
      stdio: "ignore",
    });
    const holder = path.join(state, "lanes", "lane-1.holder");
    for (let i = 0; i < 100 && !fs.existsSync(holder); i += 1) await new Promise((r) => setTimeout(r, 50));

    const busy = JSON.parse(fleet(["lanes", "--json"], { state, extra }).stdout);
    expect(busy.off).toBe(false);
    expect(busy.lanes).toHaveLength(1);
    expect(busy.lanes[0].cpus).toBe("0");
    expect(busy.lanes[0].holder.label).toBe("npm test");
    expect(fleet(["lanes"], { state, extra }).stdout).toMatch(/lane 1 +CPUs 0 +busy +npm test/);

    fs.writeFileSync(release, "");
    await new Promise((resolve) => job.on("exit", resolve));
    const idle = JSON.parse(fleet(["lanes", "--json"], { state, extra }).stdout);
    expect(idle.lanes[0].holder).toBeNull();
  });

  it("reports the kill switch", () => {
    const state = makeTempDir("fleet-lane-cli-");
    fs.writeFileSync(path.join(state, "lanes.off"), "");
    const r = fleet(["lanes", "--json"], { state, extra: { DOTBABEL_FLEET_LANES: "0" } });
    expect(JSON.parse(r.stdout).off).toBe(true);
    expect(fleet(["lanes"], { state, extra: { DOTBABEL_FLEET_LANES: "0" } }).stdout).toMatch(/kill switch/);
  });
});

describe("dotbabel-fleet lanes", () => {
  it("says lanes are off when DOTBABEL_FLEET_LANES=off", () => {
    const r = fleet(["lanes", "--json"], { extra: { DOTBABEL_FLEET_LANES: "off" } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ off: true, lanes: [] });
  });

  it("exits 64 when lane has no command", () => {
    expect(fleet(["lane"]).status).toBe(64);
    expect(fleet(["lane", "--"]).status).toBe(64);
    expect(fleet(["lane", "--name"]).status).toBe(64);
  });
});
