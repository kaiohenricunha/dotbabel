import { expect, it } from "vitest";
import { platformAdapter, describePlatformAdapter } from "../src/fleet/platform-adapter.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";

it("the Linux platform adapter reports pin and cpuShare as supported", () => {
  const adapter = platformAdapter("linux");
  expect(adapter.capabilities.pin.support).toBe("supported");
  expect(adapter.capabilities.cpuShare.support).toBe("supported");
  expect(adapter.lanes).toBe(true);
  for (const capability of Object.values(adapter.capabilities)) {
    expect(capability).toMatchObject({ support: "supported", network: "never", auth: "none", cacheable: false, execution: "read-only" });
    expect(capability.evidence.length).toBeGreaterThan(0);
  }
});
it("an unsupported platform turns the lanes off, and doctor says so", () => {
  for (const platform of ["darwin", "win32", "unknown"]) {
    const adapter = platformAdapter(platform);
    expect(adapter.lanes).toBe(false);
    expect(adapter.capabilities.pin.support).toBe("unsupported");
    expect(describePlatformAdapter(adapter)).toContain("lanes are off");
  }
});
it("the fleet executes commands directly and reports lanes off on an unsupported platform", () => {
  const bin = path.resolve(import.meta.dirname, "../bin/dotbabel-fleet.mjs");
  const preload = "data:text/javascript,Object.defineProperty(process,'platform',{value:'darwin'});";
  const run = (args) => spawnSync(process.execPath, ["--import", preload, bin, ...args], { encoding: "utf8" });
  const command = run(["lane", "--", process.execPath, "-e", "process.stdout.write('direct');process.exitCode=7"]);
  expect(command.status).toBe(7);
  expect(command.stdout).toBe("direct");
  expect(JSON.parse(run(["lanes", "--json"]).stdout)).toMatchObject({ off: true, platform: "darwin" });
  expect(run(["cpu-share"]).stdout).toContain("cpuShare unsupported");
});
