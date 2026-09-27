// Behavior tests for the pure half of the `dotbabel fleet` CPU lanes: which
// shell commands count as heavy, and how lane state is parsed and shown.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findHeavyCommand } from "../src/fleet/heavy.mjs";
import { cpuCount, formatLanes, parseKeyValue, parseLayout, readLaneState } from "../src/fleet/lanes.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const HEAVY = [
  ["npm test", "npm test"],
  ["npm test", "npm test"],
  ["npm t", "npm test"],
  ["npm test -- --coverage 2>&1 | tail -20", "npm test"],
  ["npm run test", "npm run test"],
  ["npm run test:unit", "npm run test:unit"],
  ["npm run coverage", "npm run coverage"],
  ["npm run attest -- --pr 424", "npm run attest"],
  ["npm --silent run test", "npm run test"],
  ["pnpm test", "pnpm test"],
  ["pnpm run coverage", "pnpm run coverage"],
  ["yarn test", "yarn test"],
  ["yarn coverage", "yarn coverage"],
  ["bun test", "bun test"],
  ["npx vitest run src/a.test.jsx", "vitest"],
  ["npx --yes vitest", "vitest"],
  ["./node_modules/.bin/vitest run", "vitest"],
  ["npx jest", "jest"],
  ["npx bats plugins/dotbabel/tests/bats/", "bats"],
  ["bats tests/", "bats"],
  ["npx playwright test", "playwright test"],
  ["npx stryker run", "stryker"],
  ["go test ./...", "go test"],
  ["/usr/local/go/bin/go test -count=1 ./internal/...", "go test"],
  ["pytest -q", "pytest"],
  [".venv/bin/pytest elt/tests -n0", "pytest"],
  ["python -m pytest tests/", "pytest"],
  ["python3.12 -m pytest", "pytest"],
  ["uv run pytest", "pytest"],
  ["poetry run pytest -x", "pytest"],
  ["tox -e py312", "tox"],
  ["make test", "make test"],
  ["make -j4 test-race", "make test-race"],
  ["cargo test", "cargo test"],
  ["cargo nextest run", "cargo test"],
  ["./gradlew test", "gradle test"],
  ["mvn verify", "mvn verify"],
  ["node --test tests/", "node --test"],
  ["dotbabel local-attest --pr 3", "dotbabel local-attest"],
  ["dotbabel quality check --profile pr --base origin/main", "dotbabel quality check"],
  ["dotbabel-local-attest --pr 3", "dotbabel local-attest"],
  ["mvn integration-test", "mvn integration-test"],
  ["./gradlew integrationTest", "gradle integrationTest"],
  ["npm run e2e:ci", "npm run e2e:ci"],
];

const HEAVY_INSIDE = [
  ["cd squadranks && npm test", "npm test"],
  ["git fetch -q; go test ./...", "go test"],
  ["(cd api && pytest)", "pytest"],
  ["echo start\nnpm test", "npm test"],
  ["CI=1 NODE_ENV=test npm test", "npm test"],
  ["time npm test", "npm test"],
  ["timeout 600 npm test", "npm test"],
  ["nice -n 10 go test ./...", "go test"],
  ["env -u DEBUG FOO=1 pytest", "pytest"],
  ["if npm test; then echo ok; fi", "npm test"],
  ["for p in a b; do go test ./$p; done", "go test"],
  ["result=$(npm test 2>&1)", "npm test"],
  ['"npm" test', "npm test"],
  ["npm install && npm test", "npm test"],
];

describe("findHeavyCommand", () => {
  it.each(HEAVY)("%j → %j", (command, label) => {
    expect(findHeavyCommand(command)).toBe(label);
  });

  it.each(HEAVY_INSIDE)("finds the heavy part of %j", (command, label) => {
    expect(findHeavyCommand(command)).toBe(label);
  });

  it.each([
    "npm install",
    "npm run build",
    "npm run test:watch",
    "npm run dev",
    "npx vitest --watch",
    "vitest watch",
    "npx jest --watchAll",
    "go build ./...",
    "go vet ./...",
    "git commit -m 'fix npm test flake'",
    'git commit -m "wip; npm test later"',
    "echo npm test",
    "grep -r 'go test' docs/",
    "cat package.json | grep vitest",
    "make build",
    "python script.py",
    "node -e 'console.log(1)'",
    "ls tests/",
    "# npm test",
    "cat <<EOF > notes.md\nnpm test\nEOF",
    "",
  ])("does not treat %j as heavy", (command) => {
    expect(findHeavyCommand(command)).toBeNull();
  });

  it("stops at a heredoc, so a heavy command after one is not seen", () => {
    expect(findHeavyCommand("cat <<'EOF' >x\nhi\nEOF\nnpm test")).toBeNull();
  });

  it("treats text it cannot parse as not heavy", () => {
    expect(findHeavyCommand("echo 'unterminated && npm test")).toBeNull();
    expect(findHeavyCommand(null)).toBeNull();
  });
});

describe("parseLayout and cpuCount", () => {
  it("reads the layout that fleet-lane.sh --layout prints", () => {
    expect(parseLayout("ncpu 16\nlane 1 0-4\nlane 2 5-9\nlane 3 10-14\n")).toEqual({
      off: false,
      ncpu: 16,
      lanes: [
        { index: 1, cpus: "0-4", width: 5 },
        { index: 2, cpus: "5-9", width: 5 },
        { index: 3, cpus: "10-14", width: 5 },
      ],
    });
  });

  it("reports lanes that are turned off", () => {
    expect(parseLayout("off\n")).toEqual({ off: true, ncpu: null, lanes: [] });
  });

  it.each([
    ["0-4", 5],
    ["7", 1],
    ["0,2,4-5", 4],
    ["", 0],
    ["x-y", 0],
  ])("counts the CPUs in %j as %d", (list, n) => {
    expect(cpuCount(list)).toBe(n);
  });
});

describe("parseKeyValue", () => {
  it("reads key=value lines and keeps '=' inside values", () => {
    expect(parseKeyValue("pid=12\nlabel=npm test\ncwd=/a=b\n\njunk\n")).toEqual({
      pid: "12",
      label: "npm test",
      cwd: "/a=b",
    });
  });
});

describe("formatLanes", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const t = (min) => String(Math.floor((now - min * 60_000) / 1000));

  it("shows each lane as busy or free, and the waiters", () => {
    const text = formatLanes({
      layout: parseLayout("ncpu 16\nlane 1 0-4\nlane 2 5-9\nlane 3 10-14\n"),
      holders: {
        1: { label: "npm test", session: "dotbabel-45", cwd: "/p/squadranks", started: t(3) },
        3: { label: "go test", session: "", cwd: "/p/moneyballer", started: t(1) },
      },
      waiters: [{ label: "pytest", session: "moneyballer-e3", started: t(0.5) }],
      now,
    });
    expect(text).toMatch(/3 lanes on 16 CPUs/);
    expect(text).toMatch(/CPU 15 stays free/);
    expect(text).toMatch(/lane 1 +CPUs 0-4 +busy +npm test +dotbabel-45 +3m/);
    expect(text).toMatch(/lane 2 +CPUs 5-9 +free/);
    expect(text).toMatch(/lane 3 +CPUs 10-14 +busy +go test/);
    expect(text).toMatch(/1 command waits/);
    expect(text).toMatch(/pytest +moneyballer-e3/);
  });

  it("lists every CPU that stays free, and counts waiters in the plural", () => {
    const text = formatLanes({
      layout: parseLayout("ncpu 8\nlane 1 0-1\nlane 2 4\n"),
      holders: {},
      waiters: [
        { label: "go test", session: "a", started: t(1) },
        { label: "pytest", session: "", started: t(2) },
      ],
      now,
    });
    expect(text).toMatch(/2 lanes on 8 CPUs\. CPUs 2-3, 5-7 stay free\./);
    expect(text).toMatch(/2 commands wait for a lane/);
    expect(text).toMatch(/pytest +- +2m/);
  });

  it("says when lanes are off", () => {
    expect(formatLanes({ layout: parseLayout("off\n"), holders: {}, waiters: [], now })).toMatch(/off/i);
  });
});

describe("the shell prefix prefilter", () => {
  // fleet-shell-prefix.sh starts node only when a command matches both of its
  // bash regexes. A heavy command that misses one of them would never reach a
  // lane, so every heavy case above must match both.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = fs.readFileSync(path.resolve(here, "../hooks/fleet-shell-prefix.sh"), "utf8");
  const regex = (name) => {
    const m = new RegExp(`^${name}='([^']+)'$`, "m").exec(script);
    return new RegExp(m[1].replaceAll("[:alnum:]", "A-Za-z0-9"));
  };
  const tools = regex("tools");
  const verbs = regex("verbs");

  it.each([...HEAVY, ...HEAVY_INSIDE])("lets %j through", (command) => {
    expect(tools.test(command) && verbs.test(command)).toBe(true);
  });

  it.each(["npm install", "node -e 'console.log(1)'", "go build ./...", "make build", "npx prettier --check ."])(
    "stops %j before node starts",
    (command) => {
      expect(tools.test(command) && verbs.test(command)).toBe(false);
    },
  );
});

describe("readLaneState", () => {
  // /proc/<pid>/stat with the start time in field 22.
  const stat = (pid, start) => `${pid} (bash) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0\n`;

  function world() {
    const root = makeTempDir("fleet-lanes-state-");
    const proc = path.join(root, "proc");
    const dir = path.join(root, "lanes");
    fs.mkdirSync(dir, { recursive: true });
    for (const [pid, start] of [
      [101, 11],
      [202, 22],
    ]) {
      fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(proc, String(pid), "stat"), stat(pid, start));
    }
    const info = (pid, start, label) => `pid=${pid}\nprocstart=${start}\nlabel=${label}\nsession=s\ncwd=/w\nstarted=1\n`;
    return { proc, dir, info };
  }
  const layout = parseLayout("ncpu 16\nlane 1 0-4\nlane 2 5-9\nlane 3 10-14\n");

  it("returns live holders and waiters, and skips the files of dead processes", () => {
    const { proc, dir, info } = world();
    fs.writeFileSync(path.join(dir, "lane-1.holder"), info(101, 11, "npm test"));
    fs.writeFileSync(path.join(dir, "lane-2.holder"), info(999, 99, "go test")); // process gone
    fs.writeFileSync(path.join(dir, "lane-3.holder"), info(202, 23, "pytest")); // pid reused
    fs.writeFileSync(path.join(dir, "wait-202.info"), info(202, 22, "bats"));
    fs.writeFileSync(path.join(dir, "wait-303.info"), info(303, 33, "jest")); // process gone
    fs.writeFileSync(path.join(dir, "queue.lock"), "");

    const { holders, waiters } = readLaneState(dir, layout, { procRoot: proc });
    expect(Object.keys(holders)).toEqual(["1"]);
    expect(holders[1].label).toBe("npm test");
    expect(waiters.map((w) => w.label)).toEqual(["bats"]);
  });

  it("reads nothing before any lane has run", () => {
    const { proc } = world();
    expect(readLaneState(path.join(proc, "missing"), layout, { procRoot: proc })).toEqual({ holders: {}, waiters: [] });
  });
});
