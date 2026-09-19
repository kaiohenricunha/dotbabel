import fs from "node:fs";

/**
 * Write a whole string to a file descriptor, synchronously.
 *
 * Bins that call `process.exit()` straight after printing cannot use
 * `process.stdout.write`, which may still be buffered when the process ends.
 * `fs.writeSync` on the descriptor is the synchronous alternative, but it has
 * two traps this function exists to close:
 *
 * - A write may be partial, so it loops until every byte is out.
 * - Reading `process.stdout.fd` makes Node set a pipe non-blocking. Past the
 *   pipe's 64 KiB capacity `writeSync` then throws `EAGAIN` instead of waiting
 *   for the reader. The first version let that escape: a `--json` report over
 *   64 KiB piped into a slow consumer died with a truncated document and exit
 *   2, and only for a slow reader, so it looked like flakiness rather than a
 *   bug. `EAGAIN` means "not yet", so it waits a moment and retries.
 *
 * Any other error is a real failure and is rethrown.
 *
 * @param {string} text
 * @param {number} [fd] Defaults to standard output.
 * @returns {void}
 */
export function writeAll(text, fd = process.stdout.fd) {
  const buffer = Buffer.from(text);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EAGAIN") throw err;
      // Sleep without spinning: the reader needs the CPU to drain the pipe.
      Atomics.wait(pause, 0, 0, 2);
    }
  }
}
