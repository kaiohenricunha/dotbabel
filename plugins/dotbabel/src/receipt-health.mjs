/**
 * The health of the run receipts in one clone, for `dotbabel doctor`.
 *
 * `/pr-conductor` records every phase attempt in `pr-<N>.json`, and the spot
 * check keeps `pr-<N>.spot-checks.json` beside it, under the git COMMON
 * directory (`run-receipt.mjs`, `spot-check-store.mjs`). Their readers are
 * strict on purpose: a file they cannot read stops `record`, the attempt cap
 * and the spot check for that pull request with exit 2. Doctor reads the same
 * files with the same validators, so a damaged file shows up before a run
 * trips on it.
 *
 * `receiptHealthReport` is pure: the caller lists and reads the files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { receiptProblem, receiptVerdict } from "./run-receipt.mjs";
import { spotCheckStoreProblem } from "./spot-check-store.mjs";

const RECEIPT_NAME = /^pr-([1-9]\d*)\.json$/;
const SPOT_CHECK_NAME = /^pr-([1-9]\d*)\.spot-checks\.json$/;

/**
 * @typedef {{ name: string, text?: string, error?: string }} ReceiptFile
 * @typedef {{ name: string, pr: number, kind: "receipt"|"spot-check log", problem: string }} DamagedFile
 * @typedef {{ receipts: number, verdicts: { ready: number, blocked: number, "in-progress": number },
 *             spotCheckLogs: number, damaged: DamagedFile[], ignored: string[] }} ReceiptHealth
 */

/**
 * Judge the files of a receipt directory with the validators their writers use.
 *
 * A receipt that validates is counted by its verdict. A file that cannot be
 * read, does not parse, or fails its validator, is listed in
 * `damaged` with the reason. A name that is neither a receipt nor a
 * spot-check log is listed in `ignored`.
 *
 * @param {ReceiptFile[]} files
 * @returns {ReceiptHealth}
 */
export function receiptHealthReport(files) {
  /** @type {ReceiptHealth} */
  const report = { receipts: 0, verdicts: { ready: 0, blocked: 0, "in-progress": 0 }, spotCheckLogs: 0, damaged: [], ignored: [] };
  for (const { name, text, error } of files) {
    const receipt = RECEIPT_NAME.exec(name);
    const spot = receipt ? null : SPOT_CHECK_NAME.exec(name);
    if (!receipt && !spot) {
      report.ignored.push(name);
      continue;
    }
    const pr = Number((receipt ?? spot)[1]);
    const kind = receipt ? "receipt" : "spot-check log";
    if (typeof error === "string") {
      report.damaged.push({ name, pr, kind, problem: `unreadable: ${error}` });
      continue;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      report.damaged.push({ name, pr, kind, problem: `not readable JSON: ${err.message}` });
      continue;
    }
    const problem = receipt ? receiptProblem(value, pr) : spotCheckStoreProblem(value, pr);
    if (problem) {
      report.damaged.push({ name, pr, kind, problem });
    } else if (receipt) {
      report.receipts += 1;
      report.verdicts[receiptVerdict(value)] += 1;
    } else {
      report.spotCheckLogs += 1;
    }
  }
  report.damaged.sort((a, b) => a.pr - b.pr || a.name.localeCompare(b.name));
  report.ignored.sort();
  return report;
}

/**
 * Read a receipt directory the way pr-stack reads it. An entry with a receipt
 * or spot-check name is read even when it is a symlink, and one that cannot
 * be read (a directory, a denied file) comes back with its own `error`, so it
 * hides no other file. Any other entry is listed by name only; lock
 * directories (`<file>.lock`) are skipped. A directory that does not exist
 * yet holds no receipts; one that cannot be listed is an error, never "no
 * receipts".
 *
 * @param {string} dir Absolute path of `<git-common-dir>/dotbabel/receipts`.
 * @returns {{ files: ReceiptFile[], error: string|null }}
 */
export function readReceiptDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { files: [], error: null };
    return { files: [], error: `${err.code ?? "error"}: ${err.message}` };
  }
  const files = [];
  for (const e of entries) {
    if (!RECEIPT_NAME.test(e.name) && !SPOT_CHECK_NAME.test(e.name)) {
      if (e.isFile()) files.push({ name: e.name, text: "" });
      continue;
    }
    try {
      files.push({ name: e.name, text: readFileSync(join(dir, e.name), "utf8") });
    } catch (err) {
      files.push({ name: e.name, error: `${err.code ?? "error"}: ${err.message}` });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, error: null };
}
