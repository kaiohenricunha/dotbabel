import { describe, expect, it } from "vitest";

import {
  matrixFromWorkflows,
  renderConfig,
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

  it("renders warnings as TODO comments inside the file, where they cannot be missed", () => {
    const out = renderConfig({
      legs: [{ name: "a", mode: "hard", command: "true", lane: "j", source: "x" }],
      warnings: ["t.yml job build: strategy.matrix is not translated"],
      toolchain: null,
    });
    expect(out).toMatch(/TODO.*strategy\.matrix/);
  });
});
