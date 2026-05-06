/**
 * Tiny argv parser built on Node's `util.parseArgs` (available since Node 18,
 * engines.node `>=20`).
 *
 * Recognizes the harness-wide flag set:
 *   --help / -h       bool
 *   --version / -V    bool
 *   --json            bool
 *   --verbose / -v    bool
 *   --no-color        bool
 *
 * Callers add their own flags via the `spec` parameter; the harness-wide set
 * is merged in automatically.
 *
 * @typedef {object} FlagSpec
 * @property {'boolean'|'string'} type
 * @property {string} [short]       single-letter alias
 * @property {string|boolean} [default]
 * @property {boolean} [multiple]   allow repetition (array of values)
 *
 * @typedef {{ [name: string]: FlagSpec }} FlagsSpec
 *
 * @typedef {object} ParsedArgs
 * @property {{ [name: string]: boolean|string|string[]|undefined }} flags
 * @property {string[]} positional
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} json
 * @property {boolean} verbose
 * @property {boolean} noColor
 */

import { parseArgs } from 'node:util';

/** Harness-wide flag set auto-included in every `parse()` call. */
export const HARNESS_FLAGS = Object.freeze({
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
});

/**
 * Parse `argv` (typically `process.argv.slice(2)`) against `spec`.
 * Throws `Error` with a `.code = 'USAGE_UNKNOWN_FLAG'` property on unknown
 * flags so callers can map to `EXIT_CODES.USAGE` without string matching.
 *
 * @param {string[]} argv
 * @param {FlagsSpec} [spec]
 * @returns {ParsedArgs}
 */
export function parse(argv, spec = {}) {
  const merged = { ...HARNESS_FLAGS, ...spec };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: /** @type {any} */ (merged),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const wrapped = new Error(err instanceof Error ? err.message : String(err));
    /** @type {any} */ (wrapped).code = 'USAGE_UNKNOWN_FLAG';
    throw wrapped;
  }
  const values = /** @type {Record<string, any>} */ (parsed.values);
  return {
    flags: values,
    positional: parsed.positionals,
    help: Boolean(values.help),
    version: Boolean(values.version),
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    noColor: Boolean(values['no-color']),
  };
}

/**
 * Render a conventional `--help` message.
 *
 * @param {object} meta
 * @param {string} meta.name         e.g. "dotbabel-validate-specs"
 * @param {string} meta.synopsis     e.g. "dotbabel-validate-specs [OPTIONS]"
 * @param {string} meta.description  1-2 sentence summary.
 * @param {FlagsSpec} [meta.flags]   Bin-specific flags to document (harness-wide flags are always appended).
 * @returns {string}
 */
export function helpText(meta) {
  const lines = [
    meta.synopsis,
    '',
    meta.description,
    '',
    'Options:',
  ];
  const all = { ...(meta.flags ?? {}), ...HARNESS_FLAGS };
  const longest = Math.max(...Object.keys(all).map((k) => k.length + 2));
  for (const [name, def] of Object.entries(all)) {
    const long = `--${name}`;
    const short = /** @type {any} */ (def).short ? `, -${/** @type {any} */ (def).short}` : '';
    lines.push(`  ${long}${short}`.padEnd(longest + 6) + (def.type === 'string' ? '<value>' : ''));
  }
  lines.push('');
  lines.push('Exit codes: 0 ok, 1 validation failure, 2 env error, 64 usage error.');
  return lines.join('\n');
}
