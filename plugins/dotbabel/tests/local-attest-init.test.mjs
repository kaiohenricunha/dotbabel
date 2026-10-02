import { describe, expect, it } from "vitest";

import {
  matrixFromWorkflows,
  renderConfig,
  scopeLegs,
  toolchainFromWorkflows,
} from "../src/local-attest-init.mjs";

const TEST_YML = `
name: test
on:
  pull_request:
    branches: [main]
jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - name: Lint
        run: npm run lint
        continue-on-error: true
      - name: Unit tests
        run: npm run test:coverage
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: api/go.mod
      - name: Go tests
        run: go test -race -count=1 ./...
`;

const BOLAO_YML = `
name: e2e
on:
  pull_request:
    paths:
      - "api/**"
      - "src/Bolao*.jsx"
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/run-e2e.sh
`;

const files = (...pairs) => pairs.map(([path, text]) => ({ path, text }));

describe("matrixFromWorkflows", () => {
  const result = () => matrixFromWorkflows(files([".github/workflows/test.yml", TEST_YML]));

  it("emits one leg per run step, named from the job and step", () => {
    const names = result().legs.map((l) => l.name);
    expect(names).toEqual([
      "frontend: npm ci",
      "frontend: Lint",
      "frontend: Unit tests",
      "backend: Go tests",
    ]);
  });

  it("carries the command verbatim — a paraphrased command attests the wrong thing", () => {
    expect(result().legs[3].command).toBe("go test -race -count=1 ./...");
  });

  it("maps continue-on-error to an advisory leg, everything else hard", () => {
    const byName = Object.fromEntries(result().legs.map((l) => [l.name, l.mode]));
    expect(byName["frontend: Lint"]).toBe("advisory");
    expect(byName["frontend: Unit tests"]).toBe("hard");
  });

  it("propagates the job's working-directory as cwd", () => {
    expect(result().legs[3].cwd).toBe("api");
    expect(result().legs[0].cwd).toBeUndefined();
  });

  it("skips `uses:` steps — actions have no local equivalent", () => {
    expect(result().legs.every((l) => l.command && !l.command.includes("actions/"))).toBe(true);
  });

  it("assigns lanes per job so independent jobs run concurrently", () => {
    const lanes = new Set(result().legs.map((l) => l.lane));
    expect(lanes).toEqual(new Set(["frontend", "backend"]));
  });

  it("records provenance for every leg — the reviewer must see what it mirrors", () => {
    expect(result().legs[1].source).toBe('.github/workflows/test.yml job "frontend" step "Lint"');
  });

  it("mirrors a workflow-level paths filter onto its legs as when.changedPaths", () => {
    const r = matrixFromWorkflows(files([".github/workflows/e2e.yml", BOLAO_YML]));
    expect(r.legs[0].when).toEqual({ changedPaths: ["api/**", "src/Bolao*.jsx"] });
  });

  it("warns on constructs it cannot translate rather than silently dropping them", () => {
    const withMatrix = `
name: t
on: [pull_request]
jobs:
  build:
    strategy:
      matrix:
        node: [20, 22]
    if: github.actor != 'dependabot[bot]'
    services:
      pg:
        image: postgres:16
    steps:
      - run: npm test
`;
    const r = matrixFromWorkflows(files([".github/workflows/t.yml", withMatrix]));
    const joined = r.warnings.join("\n");
    expect(joined).toMatch(/strategy\.matrix/);
    expect(joined).toMatch(/if:/);
    expect(joined).toMatch(/services/);
    expect(r.legs).toHaveLength(1);
  });

  it("ignores workflows with no pull_request trigger — they gate nothing on a PR", () => {
    const cron = `
name: nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  j:
    steps:
      - run: npm run nightly
`;
    const r = matrixFromWorkflows(files([".github/workflows/nightly.yml", cron]));
    expect(r.legs).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/nightly\.yml/);
  });

  it("survives unparseable YAML with a warning instead of throwing", () => {
    const r = matrixFromWorkflows(files([".github/workflows/bad.yml", "jobs: [unclosed"]));
    expect(r.legs).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/bad\.yml/);
  });

  it("keeps multi-line run blocks as one command", () => {
    const multi = `
name: t
on: [pull_request]
jobs:
  j:
    steps:
      - name: Chain
        run: |
          npm ci
          npm test
`;
    const r = matrixFromWorkflows(files([".github/workflows/t.yml", multi]));
    expect(r.legs[0].command).toBe("npm ci\nnpm test");
  });
});

describe("scopeLegs — scoped attestation is the default for drafted test legs", () => {
  const drafted = () => matrixFromWorkflows(files([".github/workflows/test.yml", TEST_YML])).legs;
  const scripts = { "": { "test:coverage": "jest --coverage", lint: "eslint ." } };
  const scoped = (scriptsByDir = scripts) => scopeLegs(drafted(), { scriptsFor: (dir) => scriptsByDir[dir] ?? null });
  const byName = (legs) => Object.fromEntries(legs.map((l) => [l.name, l]));

  it("wraps a go test step in the scoper and marks the leg scope: true", () => {
    const leg = byName(scoped())["backend: Go tests"];
    expect(leg.scope).toBe(true);
    expect(leg.command).toBe("dotbabel attest-scope --runner go -- go test -race -count=1 ./...");
    expect(leg.cwd).toBe("api");
  });

  it("keeps the CI command byte for byte after the separator, so a full run is exactly CI", () => {
    for (const leg of scoped().filter((l) => l.scope)) {
      const original = drafted().find((d) => d.name === leg.name);
      expect(leg.command.endsWith(` -- ${original.command}`)).toBe(true);
    }
  });

  it("follows a package script to the runner it calls", () => {
    const leg = byName(scoped())["frontend: Unit tests"];
    expect(leg.scope).toBe(true);
    expect(leg.command).toBe("dotbabel attest-scope --runner jest -- npm run test:coverage");
  });

  it("leaves a package script unscoped when its runner is unknown", () => {
    const leg = byName(scoped({}))["frontend: Unit tests"];
    expect(leg.scope).toBeUndefined();
    expect(leg.command).toBe("npm run test:coverage");
  });

  it("leaves steps that are not a test runner untouched", () => {
    const legs = byName(scoped());
    for (const name of ["frontend: npm ci", "frontend: Lint"]) {
      expect(legs[name].scope).toBeUndefined();
      expect(legs[name].command).toBe(drafted().find((d) => d.name === name).command);
    }
  });

  it("leaves a multi-line or chained step untouched, since it cannot be rewritten faithfully", () => {
    const legs = scopeLegs(
      [
        { name: "a", mode: "hard", command: "npm ci\nnpm test", lane: "j", source: "x" },
        { name: "b", mode: "hard", command: "go vet ./... && go test ./...", lane: "j", source: "x" },
      ],
      { scriptsFor: () => ({ test: "jest" }) },
    );
    expect(legs.every((l) => l.scope === undefined)).toBe(true);
  });

  it("keeps a workflow path filter on a scoped leg", () => {
    const legs = scopeLegs(
      [{ name: "t", mode: "hard", command: "pytest -q", lane: "j", source: "x", when: { changedPaths: ["api/**"] } }],
      { scriptsFor: () => null },
    );
    expect(legs[0]).toMatchObject({ scope: true, when: { changedPaths: ["api/**"] } });
  });

  it("reads scripts from the leg's own directory", () => {
    const seen = [];
    scopeLegs(drafted(), { scriptsFor: (dir) => (seen.push(dir), null) });
    expect(seen).toContain("api");
    expect(seen).toContain("");
  });

  it("does not mutate the drafted legs", () => {
    const legs = drafted();
    scopeLegs(legs, { scriptsFor: () => scripts[""] });
    expect(legs.every((l) => l.scope === undefined)).toBe(true);
  });
});

describe("renderConfig with scoped legs", () => {
  const rendered = () => {
    const r = matrixFromWorkflows(files([".github/workflows/test.yml", TEST_YML]));
    const legs = scopeLegs(r.legs, { scriptsFor: () => ({ "test:coverage": "jest --coverage" }) });
    return renderConfig({ ...r, legs, toolchain: null });
  };

  it("writes scope: true and the wrapped command, and the validator accepts it", async () => {
    const { validateConfig } = await import("../src/local-attest-config.mjs");
    const out = rendered();
    expect(out).toContain("scope: true,");
    const mod = await import(`data:text/javascript,${encodeURIComponent(out)}`);
    const cfg = validateConfig(mod.default);
    expect(cfg.matrix.filter((l) => l.scope).map((l) => l.name)).toEqual(["frontend: Unit tests", "backend: Go tests"]);
  });

  it("explains the scoped default and how to run everything on demand", () => {
    const out = rendered();
    expect(out).toMatch(/scope: true/);
    expect(out).toMatch(/local-attest --full/);
  });

  it("says nothing about scoping when no leg is scoped", () => {
    const out = renderConfig({
      legs: [{ name: "a", mode: "hard", command: "make test", lane: "j", source: "x" }],
      warnings: [],
      toolchain: null,
    });
    expect(out).not.toMatch(/local-attest --full/);
  });
});

describe("toolchainFromWorkflows", () => {
  it("reads an exact node pin and a go-version-file", () => {
    expect(toolchainFromWorkflows(files([".github/workflows/test.yml", TEST_YML]))).toEqual({
      node: "22",
      goMod: "api/go.mod",
    });
  });

  it("drops a floating node range — the schema only accepts an exact major", () => {
    const floating = TEST_YML.replace("node-version: '22'", "node-version: '22.x'");
    const t = toolchainFromWorkflows(files([".github/workflows/test.yml", floating]));
    expect(t.node).toBe("22");
  });

  it("returns null when nothing is pinned", () => {
    const bare = "name: t\non: [pull_request]\njobs:\n  j:\n    steps:\n      - run: make\n";
    expect(toolchainFromWorkflows(files([".github/workflows/t.yml", bare]))).toBeNull();
  });
});

describe("renderConfig", () => {
  const rendered = () => {
    const r = matrixFromWorkflows(files([".github/workflows/test.yml", TEST_YML]));
    return renderConfig({ ...r, toolchain: { node: "22", goMod: "api/go.mod" } });
  };

  it("emits a config the validator accepts", async () => {
    const { validateConfig } = await import("../src/local-attest-config.mjs");
    // Strip the export wrapper and eval the object literal the same way a
    // dynamic import would, so the test proves the emitted file is loadable.
    const mod = await import(
      `data:text/javascript,${encodeURIComponent(rendered().replace(/^#!.*\n/, ""))}`
    );
    expect(() => validateConfig(mod.default)).not.toThrow();
  });

  it("carries provenance comments, not just data", () => {
    expect(rendered()).toContain('job "frontend" step "Lint"');
  });

  it("leads with a review banner — a generated matrix is a draft, never a gate", () => {
    expect(rendered()).toMatch(/REVIEW THIS FILE/);
  });

  describe("attestation adoption guidance", () => {
    const draft = (legs) => renderConfig({ legs, warnings: [], toolchain: null });
    const leg = (name, command, mode = "hard") => ({ name, mode, command, lane: "j", source: "x" });

    it("explains how to make attestation merge-authorizing, and points at the guide", () => {
      const out = draft([leg("test", "go test ./...")]);
      expect(out).toContain("docs/attestation.md");
      expect(out).toMatch(/"enforce": true/);
      expect(out).toMatch(/dotbabel doctor/);
    });

    it("lists the hard legs as the suggested required_legs and leaves advisory ones out", () => {
      const out = draft([
        leg("lint", "make lint"),
        leg("test", "make test"),
        leg("knip", "make knip", "advisory"),
      ]);
      const suggested = out.split("\n").find((l) => l.includes('"required_legs"'));
      expect(suggested).toContain('"lint"');
      expect(suggested).toContain('"test"');
      expect(suggested).not.toContain('"knip"');
    });

    it("suggests governing package.json only when a leg runs a package script", () => {
      const withPkg = draft([leg("test", "npm test")]);
      const without = draft([leg("test", "go test ./...")]);
      const line = (out) => out.split("\n").find((l) => l.includes('"governance_files"'));
      expect(line(withPkg)).toContain('"package.json"');
      expect(line(without)).not.toContain("package.json");
    });

    it("always suggests governing the config file and .dotbabel.json", () => {
      const line = draft([leg("test", "make test")])
        .split("\n")
        .find((l) => l.includes('"governance_files"'));
      expect(line).toContain('".local-attest.config.mjs"');
      expect(line).toContain('".dotbabel.json"');
    });

    it("says why: a governed file cannot be edited by a pull request that attests itself", () => {
      expect(draft([leg("test", "make test")])).toMatch(/cannot attest its own change/);
    });

    it("keeps the guidance inside comments, so the file still loads", async () => {
      const { validateConfig } = await import("../src/local-attest-config.mjs");
      const out = draft([leg("test", "npm test")]);
      const mod = await import(`data:text/javascript,${encodeURIComponent(out)}`);
      expect(() => validateConfig(mod.default)).not.toThrow();
    });

    it("omits the required_legs example when there is no hard leg to require", () => {
      const out = draft([leg("knip", "make knip", "advisory")]);
      expect(out).not.toContain('"required_legs"');
    });
  });

  it("renders warnings as TODO comments inside the file, where they cannot be missed", () => {
    const out = renderConfig({
      legs: [{ name: "a", mode: "hard", command: "true", lane: "j", source: "x" }],
      warnings: ["t.yml job build: strategy.matrix is not translated"],
      toolchain: null,
    });
    expect(out).toMatch(/TODO.*strategy\.matrix/);
  });
});
