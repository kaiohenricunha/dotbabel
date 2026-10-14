/**
 * The Stryker test runner this repository uses: the upstream Vitest runner with
 * one repair to how a mutant run selects its tests.
 *
 * `@stryker-mutator/vitest-runner` 10.0.0 names each test by joining its suite
 * and test names with spaces, and filters a mutant run with a pattern built from
 * those names. Vitest 5 matches that pattern against `fullTestName`, which joins
 * the same names with " > ". So the pattern matches no test, each mutant run
 * executes zero tests, and every covered mutant reports "survived": a run on
 * `model-intelligence/policy/` scored 10.18% where the real score is 90.55%.
 * Earlier local runs passed only because a worktree without its own install
 * resolves the main checkout's Vitest 4.1, which still joined with spaces.
 *
 * The repair widens each space in the pattern to match a space or " > ", just
 * before the runner starts Vitest. That holds in every Stryker worker without
 * state, matches the Vitest 4 names too, and still matches once upstream joins
 * with " > ". Delete this file and select `vitest` again when a published runner
 * builds names Vitest 5 can match: its `collectTestName` in `dist/src/test-helpers.js`
 * then joins with " > " instead of a space.
 *
 * The upstream runner exports only its plugin list, so the class is imported
 * from its file. A runner upgrade that moves that file fails the test above.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { INSTRUMENTER_CONSTANTS } from "@stryker-mutator/api/core";
import { PluginKind, commonTokens, declareFactoryPlugin, tokens } from "@stryker-mutator/api/plugin";

const require = createRequire(import.meta.url);
const upstreamDir = path.dirname(require.resolve("@stryker-mutator/vitest-runner/package.json"));
const { VitestTestRunner } = await import(pathToFileURL(path.join(upstreamDir, "dist", "src", "vitest-test-runner.js")).href);

/** The `testRunner` name that `stryker.config.mjs` selects. */
export const RUNNER_NAME = "vitest-dotbabel";

/** What a space in a test-name pattern may stand for: the space of Vitest 4, or the " > " of Vitest 5. */
const SEPARATOR = "(?: | > )";

/** Patterns this module already widened, so a second pass cannot nest the groups. */
const widened = new WeakSet();

/**
 * Let every space in a test-name pattern also match Vitest 5's " > " separator.
 *
 * The upstream runner escapes each name before it joins them with `|`, so every
 * space in `source` is a literal space from a name, never regular-expression
 * syntax.
 * @param {unknown} pattern
 * @returns {unknown} A widened `RegExp`, or `pattern` itself when it is not one or is already widened.
 */
export function widenNamePattern(pattern) {
  if (!(pattern instanceof RegExp) || widened.has(pattern)) return pattern;
  const result = new RegExp(pattern.source.replaceAll(" ", SEPARATOR), pattern.flags);
  widened.add(result);
  return result;
}

/** The upstream Vitest runner, with each mutant run's test-name filter widened. */
export class NamePatternVitestTestRunner extends VitestTestRunner {
  /**
   * Start the upstream runner, then wrap the Vitest instance's `start`, which the
   * upstream `run` calls right after it sets each project's `testNamePattern`.
   * @returns {Promise<void>}
   */
  async init() {
    await super.init();
    const start = this.ctx.start.bind(this.ctx);
    this.ctx.start = (filters) => {
      for (const project of this.ctx.projects) project.config.testNamePattern = widenNamePattern(project.config.testNamePattern);
      return start(filters);
    };
  }
}

/**
 * Build the runner the way the upstream factory does, with the instrumenter's namespace.
 * @param {import("@stryker-mutator/api/plugin").Injector} injector
 * @returns {NamePatternVitestTestRunner}
 */
function createRunner(injector) {
  return injector.provideValue("globalNamespace", INSTRUMENTER_CONSTANTS.NAMESPACE).injectClass(NamePatternVitestTestRunner);
}
createRunner.inject = tokens(commonTokens.injector);

/** The plugin Stryker loads through `plugins` in `stryker.config.mjs`. */
export const strykerPlugins = [declareFactoryPlugin(PluginKind.TestRunner, RUNNER_NAME, createRunner)];
