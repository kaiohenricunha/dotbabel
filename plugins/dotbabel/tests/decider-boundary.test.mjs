import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("no merge gate module imports the decider module", () => {
  const src = path.resolve(import.meta.dirname, "../src");
  const visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const text = fs.readFileSync(file, "utf8");
    const imports = [...text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)].map((m) => path.resolve(path.dirname(file), m[1]));
    for (const dependency of imports) {
      expect(dependency).not.toMatch(/decider|jev-adapter/);
      if (fs.existsSync(dependency) && dependency.endsWith(".mjs")) walk(dependency);
    }
  }
  for (const name of ["pr-gates.mjs", "attestation.mjs", "local-attest-runner.mjs", "merge-verification.mjs"]) walk(path.join(src, name));
});
