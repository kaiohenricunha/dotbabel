import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getQualityAdapter } from "../src/quality/adapters/registry.mjs";

describe("quality adapters", () => {
  it.each(["go", "python", "typescript", "javascript"])("registers the %s adapter", (language) => {
    expect(getQualityAdapter(language)?.id).toBe(language);
  });

  it("uses built-ins without installing tools", () => {
    const adapter = getQualityAdapter("go");
    const plans = adapter.plan({ id: ".:go", root: ".", language: "go", files: ["main.go"], tools: {} }, { rules: {} }, { changedFiles: [{ path: "main.go" }] }, "fast");
    expect(plans.some((plan) => plan.argv?.includes("install"))).toBe(false);
    expect(plans.some((plan) => plan.capability === "format")).toBe(true);
  });

  it("keeps mutation out of fast and pr profiles", () => {
    const adapter = getQualityAdapter("python");
    for (const profile of ["fast", "pr"]) {
      expect(adapter.plan({ id: ".:python", root: ".", language: "python", files: ["a.py"], tools: {} }, { rules: {} }, { changedFiles: [] }, profile).some((plan) => plan.capability === "mutation")).toBe(false);
    }
  });

  it("keeps tests and coverage out of the fast profile", () => {
    const adapter = getQualityAdapter("javascript");
    const plans = adapter.plan({ id: ".:javascript", root: ".", absoluteRoot: process.cwd(), language: "javascript", files: [], tools: {
      test: { argv: ["npm", "test"] }, coverage: { argv: ["npm", "run", "coverage"] }, lint: { argv: ["npm", "run", "lint"] },
    } }, { rules: {} }, { changedFiles: [] }, "fast");
    expect(plans.map((plan) => plan.capability)).toEqual(["lint"]);
  });

  it("prefers a repository quality script over a conventional script", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-node-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint .", lint: "eslint src" } }));
      const plans = getQualityAdapter("javascript").plan({ id: ".:javascript", root: ".", absoluteRoot: root, language: "javascript", files: [], markers: ["package.json"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint").argv).toEqual(["run", "quality:lint"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("reports equal-authority quality scripts as ambiguous", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-node-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint .", "quality-lint": "eslint src" } }));
      const plans = getQualityAdapter("javascript").plan({ id: ".:javascript", root: ".", absoluteRoot: root, language: "javascript", files: [], markers: ["package.json"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ availability: "not_configured", candidates: ["quality:lint", "quality-lint"] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("prefers a Go quality Make target over the built-in", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-go-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "Makefile"), "quality-test:\n\tgo test ./...\n");
      const plans = getQualityAdapter("go").plan({ id: ".:go", root: ".", absoluteRoot: root, language: "go", files: ["main.go"], markers: ["go.mod"], tools: {} }, { rules: {} }, { changedFiles: [] }, "pr");
      expect(plans.find((plan) => plan.capability === "test")).toMatchObject({ executable: "make", argv: ["quality-test"], source: "repository-target" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the detected Python package manager for configured Ruff", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-python-adapter-"));
    try {
      fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
      fs.writeFileSync(path.join(root, "uv.lock"), "");
      const plans = getQualityAdapter("python").plan({ id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["a.py"], markers: ["pyproject.toml"], tools: {} }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "uv", argv: ["run", "ruff", "check", "."], requiresTrust: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a local TypeScript compiler and maps type checks to compile and type rules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-typescript-adapter-"));
    try {
      fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", ".bin", "tsc"), "");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "quality:lint": "eslint ." } }));
      const plans = getQualityAdapter("typescript").plan({
        id: ".:typescript", root: ".", absoluteRoot: root, language: "typescript", files: ["a.ts"], markers: ["tsconfig.json"], tools: {},
      }, { rules: {} }, { changedFiles: [{ path: "a.ts" }] }, "fast");
      expect(plans.find((plan) => plan.capability === "lint")).toMatchObject({ executable: "npm", argv: ["run", "quality:lint"] });
      expect(plans.find((plan) => plan.capability === "typecheck")).toMatchObject({
        executable: "./node_modules/.bin/tsc",
        argv: ["--noEmit", "-p", "tsconfig.json"],
        ruleIds: ["correctness.compile", "correctness.types"],
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a PATH TypeScript compiler when no project binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-typescript-adapter-"));
    try {
      const plans = getQualityAdapter("typescript").plan({
        id: ".:typescript", root: ".", absoluteRoot: root, language: "typescript", files: ["a.ts"], markers: [], tools: {},
      }, { rules: {} }, { changedFiles: [] }, "fast");
      expect(plans.find((plan) => plan.capability === "typecheck")).toMatchObject({ executable: "tsc", argv: ["--noEmit", "-p", "tsconfig.json"] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("terminates node --check flag parsing so a changed filename cannot inject a Node CLI flag", () => {
    const evil = "--require=payload.js";
    const plans = getQualityAdapter("javascript").plan({
      id: ".:javascript", root: ".", absoluteRoot: process.cwd(), language: "javascript", files: [evil], tools: {},
    }, { rules: {} }, { changedFiles: [{ path: evil }] }, "fast");
    const plan = plans.find((item) => item.capability === "compile" && item.source === "built-in");
    expect(plan.argv[0]).toBe("--check");
    expect(plan.argv[1]).toBe("--");
    expect(plan.argv[2]).toMatch(/^\.\//);
  });

  it("terminates gofmt flag parsing so a changed filename cannot inject a gofmt CLI flag", () => {
    const evil = "-cpuprofile=pwned.go";
    const plans = getQualityAdapter("go").plan({
      id: ".:go", root: ".", absoluteRoot: process.cwd(), language: "go", files: [evil], tools: {},
    }, { rules: {} }, { changedFiles: [{ path: evil }] }, "fast");
    const plan = plans.find((item) => item.capability === "format");
    expect(plan.argv[0]).toBe("-l");
    expect(plan.argv[1]).toBe("--");
    expect(plan.argv[2]).toMatch(/^\.\//);
  });
});
