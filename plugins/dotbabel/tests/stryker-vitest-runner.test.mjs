// The repository's Stryker test runner (`scripts/stryker-vitest-runner.mjs`).
//
// `@stryker-mutator/vitest-runner` 10.0.0 filters each mutant's tests with a
// pattern built from names joined by spaces, and Vitest 5 matches that pattern
// against `fullTestName`, which joins names with " > ". The pattern then
// matches nothing, every mutant run executes zero tests, and every covered
// mutant reports "survived". These tests pin the widening that repairs the
// match and the configuration that selects the repaired runner, because the
// failure is invisible until someone reads a mutation score of 10%.

import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "stryker-vitest-runner.mjs");

/**
 * Import a repository module by absolute path, as a URL so that Windows paths load.
 * @param {string} file
 * @returns {Promise<object>}
 */
const importFile = (file) => import(pathToFileURL(file).href);

/** The pattern the upstream runner builds for these test names: escaped, then joined with `|`. */
function strykerPattern(names) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(names.map(escape).join("|"));
}

describe("the repository's Stryker Vitest runner", () => {
  it("widens a space-joined test name so it matches the full name Vitest 5 builds with ' > '", async () => {
    const { widenNamePattern } = await importFile(RUNNER_PATH);
    const pattern = widenNamePattern(strykerPattern(["policy layer merge composes floors by taking the strongest applicable minimum"]));
    // Vitest 5 `fullTestName`: describe and test joined with " > ".
    expect("policy layer merge > composes floors by taking the strongest applicable minimum").toMatch(pattern);
    // Vitest 4 joined with spaces; the widened pattern still matches that.
    expect("policy layer merge composes floors by taking the strongest applicable minimum").toMatch(pattern);
    // Nested describes: every boundary may be either separator.
    expect("outer suite > inner suite > the test").toMatch(widenNamePattern(strykerPattern(["outer suite inner suite the test"])));
    // A different test is still not selected.
    expect("policy layer merge > records every shadowed pin when three layers declare one").not.toMatch(pattern);
  });

  it("keeps escaped regular-expression characters literal, keeps the flags, and widens a pattern only once", async () => {
    const { widenNamePattern } = await importFile(RUNNER_PATH);
    const pattern = widenNamePattern(strykerPattern(['reads policy from configDir() and .dotbabel.json, such as the string "true"']));
    expect('suite > reads policy from configDir() and .dotbabel.json, such as the string "true"').toMatch(pattern);
    // `(` `)` `.` stay literal: "configDirX" must not match where "configDir()" is required.
    expect('suite > reads policy from configDirX and Xdotbabel.json, such as the string "true"').not.toMatch(pattern);
    // Alternatives of several tests survive the widening.
    const either = widenNamePattern(strykerPattern(["a first test", "a second test"]));
    expect("s > a second test").toMatch(either);
    expect(widenNamePattern(/a b/i).flags).toBe("i");
    // A widened pattern passes through unchanged, so wrapping one run twice cannot nest the groups.
    const once = widenNamePattern(/x y/);
    expect(widenNamePattern(once)).toBe(once);
    // Anything that is not a pattern is left alone: no filter means every test runs.
    expect(widenNamePattern(undefined)).toBeUndefined();
  });

  it("registers one test runner that extends the upstream Vitest runner", async () => {
    const { strykerPlugins, RUNNER_NAME, NamePatternVitestTestRunner } = await importFile(RUNNER_PATH);
    expect(RUNNER_NAME).toBe("vitest-dotbabel");
    expect(strykerPlugins).toHaveLength(1);
    expect(strykerPlugins[0]).toMatchObject({ kind: "TestRunner", name: RUNNER_NAME });
    // The deep import of the upstream class must keep resolving: a runner upgrade that moves it fails here,
    // in CI, rather than in a local mutation run.
    const require = createRequire(import.meta.url);
    const upstreamDir = path.dirname(require.resolve("@stryker-mutator/vitest-runner/package.json"));
    const { VitestTestRunner } = await importFile(path.join(upstreamDir, "dist", "src", "vitest-test-runner.js"));
    expect(Object.getPrototypeOf(NamePatternVitestTestRunner)).toBe(VitestTestRunner);
    expect(NamePatternVitestTestRunner.inject).toEqual(VitestTestRunner.inject);
  });

  it("is the runner the Stryker configuration selects, next to the upstream plugin that carries the vitest options", async () => {
    const config = (await importFile(path.join(REPO_ROOT, "stryker.config.mjs"))).default;
    expect(config.testRunner).toBe("vitest-dotbabel");
    expect(config.plugins).toEqual(["@stryker-mutator/vitest-runner", "./scripts/stryker-vitest-runner.mjs"]);
    // The per-test coverage analysis stays: the repair is to the name filter, not a slower mode.
    expect(config.coverageAnalysis).toBe("perTest");
    const harness = (await importFile(path.join(REPO_ROOT, "stryker.harness.config.mjs"))).default;
    expect(harness.testRunner).toBe("vitest-dotbabel");
    expect(harness.plugins).toEqual(config.plugins);
  });
});
