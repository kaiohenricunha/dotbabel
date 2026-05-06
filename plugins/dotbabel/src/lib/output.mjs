/**
 * Shared CLI output primitives — the JS parity of
 * `plugins/dotclaude/scripts/validate-settings.sh:43-45`.
 *
 * Provides the same ✓/✗/⚠ format with ANSI coloring when the stream is a TTY,
 * plus a `--json` buffer-and-flush mode so CI pipelines can consume a single
 * JSON array of events instead of regexing stderr.
 *
 * @typedef {'pass'|'fail'|'warn'|'info'} OutputKind
 *
 * @typedef {object} OutputEvent
 * @property {OutputKind} kind
 * @property {string} message
 * @property {object} [details]  Optional structured payload (e.g. `ValidationError.toJSON()`).
 *
 * @typedef {object} Output
 * @property {(msg: string) => void} pass
 * @property {(msg: string, details?: object) => void} fail
 * @property {(msg: string, details?: object) => void} warn
 * @property {(msg: string) => void} info
 * @property {() => void} flush          Emit buffered JSON when in json mode. No-op otherwise.
 * @property {() => { fail: number, warn: number, pass: number }} counts
 *
 * @typedef {object} OutputOptions
 * @property {boolean} [json]     When true, buffer events and emit a JSON array on flush().
 * @property {boolean} [noColor]  When true, suppress ANSI escapes regardless of TTY.
 * @property {boolean} [quiet]    When true, suppress pass/info events; fail/warn still emit.
 * @property {NodeJS.WritableStream} [stream]  Defaults to process.stdout.
 * @property {NodeJS.ProcessEnv} [env]         Defaults to process.env.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/**
 * Construct an `Output` with the given behavior flags.
 *
 * @param {OutputOptions} [opts]
 * @returns {Output}
 */
export function createOutput(opts = {}) {
  const env = opts.env ?? process.env;
  const stream = opts.stream ?? process.stdout;
  const json = Boolean(opts.json);
  const noColor = Boolean(opts.noColor) || 'NO_COLOR' in env;
  const quiet = Boolean(opts.quiet);
  const useAnsi = !json && !noColor && Boolean(stream.isTTY);

  const counts = { pass: 0, fail: 0, warn: 0 };
  /** @type {OutputEvent[]} */
  const buffer = [];

  const color = (code, text) => (useAnsi ? `${code}${text}${RESET}` : text);

  /**
   * @param {OutputKind} kind
   * @param {string} message
   * @param {object} [details]
   */
  const emit = (kind, message, details) => {
    if (kind === 'pass') counts.pass++;
    else if (kind === 'fail') counts.fail++;
    else if (kind === 'warn') counts.warn++;
    // quiet mode: suppress per-file progress (pass/info); fail/warn always surface
    if (quiet && (kind === 'pass' || kind === 'info')) return;
    if (json) {
      /** @type {OutputEvent} */
      const event = { kind, message };
      if (details !== undefined) event.details = details;
      buffer.push(event);
      return;
    }
    let glyph;
    if (kind === 'pass') glyph = color(GREEN, '✓');
    else if (kind === 'fail') glyph = color(RED, '✗');
    else if (kind === 'warn') glyph = color(YELLOW, '⚠');
    else glyph = ' ';
    stream.write(`  ${glyph} ${message}\n`);
  };

  return {
    pass: (msg) => emit('pass', msg),
    fail: (msg, details) => emit('fail', msg, details),
    warn: (msg, details) => emit('warn', msg, details),
    info: (msg) => emit('info', msg),
    flush: () => {
      if (!json) return;
      stream.write(JSON.stringify({ events: buffer, counts }, null, 2) + '\n');
    },
    counts: () => ({ ...counts }),
  };
}
