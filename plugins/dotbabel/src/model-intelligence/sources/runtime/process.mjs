/**
 * model-intelligence/sources/runtime/process — how a runtime adapter runs a CLI safely
 * (docs/specs/model-intelligence, SEC-1, REL-1, OPS-2, OPS-4, ARCH-56).
 *
 * `sources/` is the boundary module that owns subprocess I/O (ARCH-56). This file is where that
 * I/O is confined, so the two adapters above it contain classification and nothing else.
 *
 * The central decision is that a runtime is NEVER run against the user's real configuration.
 * Measured while writing the adapters, both CLIs write into their configuration root even for a
 * command that starts no model turn: `codex exec` wrote 4.2 MB (rollout files, sqlite databases,
 * shell snapshots) and Claude Code wrote projects, backups and telemetry, even with
 * `--no-session-persistence`. SEC-1 says an adapter that mutates a runtime configuration root is
 * treated as unsupported, so every run happens in a fresh scratch home instead:
 *
 * - the environment is built from an allow-list, so no credential can reach the child;
 * - every proxy variable points at a dead port, and `NO_PROXY` is emptied so an ambient value cannot
 *   exempt the provider host, so no request can leave the machine;
 * - the scratch directory is removed afterwards, and it is checked to lie outside the real root first.
 *
 * With no credential and no route, a run cannot bill a turn whatever the caller does next, which is
 * the property that makes it safe to probe a runtime's own validation.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isSecretName, isVersionString, makeAdapterResult, runBounded } from "../contract.mjs";

/** A closed local port. A connection to it is refused at once and nothing leaves the machine. */
export const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * A defensive bound on one run's total output, sized to the OPS-2 per-entry limit that P-9 will
 * enforce on the capability cache. This is not itself OPS-2: OPS-2 bounds a cache entry, not a
 * subprocess, and belongs to P-9, not this module.
 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How long a child gets to exit on SIGTERM before it is killed. */
const KILL_GRACE_MS = 1_000;

/**
 * The names this function itself pins. A caller's `extra` is spread after them, so an unguarded
 * collision -- `extra: { NO_PROXY: "..." }` or `extra: { HOME: realHome }` -- would silently win and
 * unpin the scratch home or the dead-port network isolation, with no error and nothing to catch it.
 */
const ISOLATION_PINNED_NAMES = new Set(["PATH", "HOME", "TERM", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "NO_PROXY"]);

/**
 * Build the environment a runtime is run with.
 *
 * Only `PATH` is taken from the source, because the child must be able to find its own helpers. Every
 * other variable, including any credential, is absent, and the proxy variables point at a dead port.
 * @param {object} input
 * @param {Record<string, string|undefined>} [input.source] The caller's environment. Read for PATH only.
 * @param {string} input.home The scratch home.
 * @param {Record<string, string>} [input.extra] Variables to add, such as a runtime's config-root variable. A credential is refused.
 * @returns {Record<string, string>}
 */
export function buildIsolatedEnv({ source = {}, home, extra = {} }) {
  for (const name of Object.keys(extra)) {
    if (isSecretName(name)) throw new TypeError(`buildIsolatedEnv: "${name}" looks like a credential and is never passed to a runtime`);
    if (ISOLATION_PINNED_NAMES.has(name)) throw new TypeError(`buildIsolatedEnv: "${name}" is an isolation pin and cannot be overridden by "extra"`);
  }
  return {
    PATH: source.PATH ?? "",
    HOME: home,
    TERM: "dumb",
    HTTPS_PROXY: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    all_proxy: DEAD_PROXY,
    NO_PROXY: "",
    ...extra,
  };
}

/**
 * Resolve a path through symlinks even when its tail does not exist yet.
 * @param {string} path
 * @returns {string}
 */
function canonical(path) {
  let current = resolve(path);
  /** @type {string[]} */
  const tail = [];
  while (!existsSync(current) && dirname(current) !== current) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...tail);
}

/**
 * Throw when `candidate` is the runtime configuration root or lies inside it (SEC-1).
 * @param {string} candidate
 * @param {string | undefined} root
 * @returns {void}
 */
export function assertOutsideRoot(candidate, root) {
  if (root === undefined || root === "") return;
  const target = canonical(candidate);
  const protectedRoot = canonical(root);
  if (target === protectedRoot || target.startsWith(protectedRoot + sep)) {
    throw new Error(`${candidate} is inside the runtime configuration root ${root}, which an adapter never writes to (SEC-1)`);
  }
}

/**
 * Run `fn` with a fresh scratch directory and remove it afterwards, even when `fn` throws.
 *
 * Only a directory created here is removed, and it is removed whole, so nothing outside it can be
 * deleted by this function.
 * @template T
 * @param {string} prefix
 * @param {(root: string) => Promise<T>} fn
 * @param {{tmpdir?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withScratchRoot(prefix, fn, { tmpdir: base = tmpdir() } = {}) {
  const root = await mkdtemp(join(base, `${prefix}-`));
  try {
    return await fn(root);
  } finally {
    // A retry, not just `force`, is defense in depth against a straggler that is still writing:
    // `force` only swallows `ENOENT`, not `ENOTEMPTY`/`EBUSY` from a concurrent writer.
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/**
 * @typedef {object} ProcessSpec
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {number} [maxOutputBytes]
 * @property {(streams: {stdout: string, stderr: string}) => boolean} [stopWhen] Ends the child as soon as it returns true, for a runtime that prints what is wanted and then keeps running.
 */

/**
 * @typedef {object} ProcessOutcome
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} truncated Output hit the cap and the child was stopped.
 * @property {boolean} stoppedEarly `stopWhen` ended the child.
 * @property {boolean} aborted The signal ended the child.
 */

/**
 * Run a command with no shell and bounded output.
 *
 * The arguments are an array handed straight to the operating system, so nothing is parsed by a
 * shell and no value can inject an option or a command. Output is decoded per stream so a multibyte
 * character split across two chunks survives, and it is capped, so a runaway child cannot exhaust memory.
 *
 * A child that cannot be started (for example ENOENT) rejects with the error, and the caller turns that
 * into a `binary_missing` diagnostic. A child that is stopped, by `stopWhen`, the signal or the output
 * cap, is sent SIGTERM and then SIGKILL after a grace period.
 * @param {ProcessSpec} spec
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<ProcessOutcome>}
 */
export function runProcess(spec, { signal } = {}) {
  const { command, args, cwd, env, stopWhen, maxOutputBytes = MAX_OUTPUT_BYTES } = spec;
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    const out = { stdout: "", stderr: "" };
    // One shared budget across both streams (OPS-2), not one per stream: a per-stream budget would
    // let a run retain up to two times `maxOutputBytes` before either stream was individually
    // flagged, and both `validate` paths concatenate stdout and stderr before parsing them.
    let bytesUsed = 0;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let truncated = false;
    let stoppedEarly = false;
    let aborted = false;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      // The escalation is cleared only once the child has actually exited: the `close` handler below
      // sets `exitCode`/`signalCode` before it calls `finish`. A settle reached any other way -- an
      // `error` event, or a `stopWhen` predicate that throws -- can fire while the child is still
      // alive, and clearing the timer there would leave a SIGTERM-trapping child unreaped: the
      // promise would settle, but the process would not.
      if (killTimer !== undefined && (child.exitCode !== null || child.signalCode !== null)) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    /** @param {"stdout" | "stderr"} name */
    const onData = (name) => (/** @type {Buffer} */ chunk) => {
      if (truncated) return;
      const room = maxOutputBytes - bytesUsed;
      const kept = chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk;
      bytesUsed += kept.length;
      out[name] += decoders[name].write(kept);
      if (kept.length < chunk.length) {
        truncated = true;
        stop();
        return;
      }
      if (stopWhen !== undefined && !stoppedEarly) {
        let done;
        try {
          done = stopWhen({ stdout: out.stdout, stderr: out.stderr });
        } catch (err) {
          stop();
          finish(() => rejectPromise(err));
          return;
        }
        if (done) {
          stoppedEarly = true;
          stop();
        }
      }
    };

    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (err) => finish(() => rejectPromise(err)));
    child.on("close", (exitCode, exitSignal) => {
      out.stdout += decoders.stdout.end();
      out.stderr += decoders.stderr.end();
      finish(() => resolvePromise({ exitCode, signal: exitSignal, stdout: out.stdout, stderr: out.stderr, truncated, stoppedEarly, aborted }));
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Require a value safe to hand to a runtime as one argument: a printable string that cannot be read as
 * an option.
 *
 * A leading dash would make the runtime parse the value as a flag, so a value that reached here from a
 * repository's own frontmatter could carry an option nobody asked for. A control character could
 * forge output or split a line.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export function assertOpaqueValue(name, value) {
  if (typeof value !== "string" || !isOpaqueString(value)) {
    throw new TypeError(`${name} must be a printable string of at most 200 characters that does not start with a dash`);
  }
  return value;
}

/**
 * True when a string is safe to hand to a runtime as one argument (see `assertOpaqueValue`).
 * @param {string} value
 * @returns {boolean}
 */
function isOpaqueString(value) {
  return value !== "" && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith("-");
}

/**
 * Check a caller-supplied value under the failure-channel rule in `contract.mjs`.
 *
 * A value that is not a string breaks the caller's contract and throws. A string that fails the
 * opaque rules is data, which may come from a repository's own frontmatter, so it returns `false`
 * for the caller to report as an `invalid_axis_value` result instead of an exception.
 * @param {string} name
 * @param {unknown} value
 * @returns {boolean} True when the value is safe to pass on.
 */
export function checkOpaqueValue(name, value) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return isOpaqueString(value);
}

/**
 * The `unknown` result for a caller-supplied value that failed `checkOpaqueValue`. The message names
 * the axis and never echoes the value (OPS-4).
 * @param {RuntimeContext} ctx
 * @param {object} provenance
 * @param {string} axis
 * @returns {object}
 */
export function invalidAxisValue(ctx, provenance, axis) {
  return makeAdapterResult({
    status: "unknown",
    provenance,
    observedAt: ctx.now(),
    diagnostic: { code: "invalid_axis_value", message: `the ${axis} value is not safe to pass to the runtime: it is empty, longer than 200 characters, holds a control character, or starts with a dash` },
  });
}

/**
 * Extract a version from the text a runtime prints for `--version`. Never echoes the text.
 * @param {unknown} text
 * @returns {string | undefined}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return undefined;
  const found = /(?<![\d.])\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?/.exec(text);
  return found !== null && isVersionString(found[0]) ? found[0] : undefined;
}

/**
 * The first non-empty line of some text, bounded, for use in a diagnostic message.
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? "" : line.slice(0, 300);
}

/**
 * @typedef {object} RuntimeContext
 * @property {(spec: ProcessSpec, options: {signal: AbortSignal}) => Promise<ProcessOutcome>} runCommand
 * @property {Record<string, string|undefined>} env The caller's environment. Only PATH is passed on.
 * @property {string} homeDir
 * @property {string} realRoot The runtime's real configuration root, which is read at most and never written.
 * @property {() => string} now
 * @property {number} [timeoutMs]
 * @property {string} [tmpDir]
 * @property {(path: string, encoding: "utf8") => Promise<string>} readFile
 */

/**
 * Resolve the dependencies an adapter operation runs with, so a test can inject every one of them.
 * @param {object} context
 * @param {{rootEnvVar: string, rootDirName: string}} runtime
 * @returns {RuntimeContext}
 */
export function resolveContext(context, { rootEnvVar, rootDirName }) {
  const ctx = /** @type {any} */ (context ?? {});
  const env = ctx.env ?? process.env;
  const homeDir = ctx.homeDir ?? homedir();
  const configured = env[rootEnvVar];
  return {
    runCommand: ctx.runCommand ?? runProcess,
    env,
    homeDir,
    realRoot: configured !== undefined && configured !== "" ? resolve(configured) : join(homeDir, rootDirName),
    now: ctx.now ?? (() => new Date().toISOString()),
    timeoutMs: ctx.timeoutMs,
    tmpDir: ctx.tmpDir,
    readFile: ctx.readFile ?? readFile,
  };
}

/**
 * Run one runtime command in a fresh scratch home, under a finite timeout, and return the bounded result.
 *
 * On success the result's evidence is the raw `ProcessOutcome`, for the adapter to classify. On a
 * timeout or a missing binary it is already the final `unavailable` result.
 * @param {RuntimeContext} ctx
 * @param {object} run
 * @param {string} run.prefix Scratch directory name prefix.
 * @param {string} run.command
 * @param {string[]} run.args
 * @param {string} run.rootEnvVar The runtime's config-root variable, pointed at the scratch root.
 * @param {(streams: {stdout: string, stderr: string}) => boolean} [run.stopWhen]
 * @param {(paths: {scratch: string, home: string, work: string, runtimeRoot: string}) => Promise<void>} [run.prepare] Runs before the child, to seed the scratch root.
 * @param {object} run.provenance
 * @returns {Promise<object>}
 */
export async function runIsolated(ctx, { prefix, command, args, rootEnvVar, stopWhen, prepare, provenance }) {
  // Checked BEFORE anything is created: a scratch directory inside the real root would make the
  // isolation a fiction, and creating it there would already be a write.
  assertOutsideRoot(ctx.tmpDir ?? tmpdir(), ctx.realRoot);
  return withScratchRoot(
    prefix,
    async (scratch) => {
      const home = join(scratch, "home");
      const work = join(scratch, "work");
      const runtimeRoot = join(scratch, "root");
      await Promise.all([home, work, runtimeRoot].map((dir) => mkdir(dir, { recursive: true })));
      assertOutsideRoot(scratch, ctx.realRoot);
      if (prepare !== undefined) await prepare({ scratch, home, work, runtimeRoot });
      const env = buildIsolatedEnv({ source: ctx.env, home, extra: { [rootEnvVar]: runtimeRoot } });
      /** @type {Promise<unknown> | undefined} */
      let operationSettled;
      const result = await runBounded(
        ({ signal }) => {
          operationSettled = ctx.runCommand({ command, args, cwd: work, env, stopWhen }, { signal });
          return operationSettled;
        },
        { channel: "subprocess", timeoutMs: ctx.timeoutMs, provenance, now: ctx.now },
      );
      // On a timeout, `runBounded` returns as soon as its race against the timer settles; it does
      // not await the losing operation. That operation is still running -- and may still be writing
      // into `scratch` -- until its own signal handling finishes killing it, so cleanup below must
      // wait for it too, or `rm` would race a live writer. A well-behaved `runCommand` settles within
      // `KILL_GRACE_MS` of its signal aborting (as `runProcess` does); the extra bound here is a
      // backstop against one that does not, so a broken caller cannot hang this indefinitely.
      if (operationSettled !== undefined) {
        /** @type {NodeJS.Timeout} */
        let backstop;
        const timedOut = new Promise((r) => {
          backstop = setTimeout(r, KILL_GRACE_MS * 3);
          backstop.unref();
        });
        await Promise.race([operationSettled.catch(() => {}), timedOut]);
        clearTimeout(backstop);
      }
      return result;
    },
    { tmpdir: ctx.tmpDir },
  );
}

/**
 * Ask a runtime for its version. A runtime that does not answer is `undefined`, because a version
 * refines provenance and must not turn a working operation into a failed one.
 *
 * Only a runtime failure is absorbed, and `runIsolated` reports those as results. An error that
 * reaches here as a throw is a safety or programming fault, such as the SEC-1 root check, and it
 * propagates: swallowing it would hide exactly the failure that guard exists to surface.
 * @param {RuntimeContext} ctx
 * @param {{prefix: string, command: string, rootEnvVar: string, provenance: object}} run
 * @returns {Promise<string | undefined>}
 */
export async function probeVersion(ctx, { prefix, command, rootEnvVar, provenance }) {
  const ran = await runIsolated(ctx, { prefix, command, args: ["--version"], rootEnvVar, provenance });
  if (/** @type {any} */ (ran).status !== "ok") return undefined;
  const outcome = /** @type {ProcessOutcome} */ (/** @type {any} */ (ran).evidence);
  return parseVersion(`${outcome.stdout}\n${outcome.stderr}`);
}
