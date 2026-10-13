import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readReceiptDir, receiptHealthReport } from "../src/receipt-health.mjs";
import { appendAttempt, createReceipt } from "../src/run-receipt.mjs";
import { appendSpotCheck, createSpotCheckStore } from "../src/spot-check-store.mjs";

const HEAD = "a".repeat(40);
const NOW = new Date("2026-10-13T12:00:00Z");

let tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-health-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function receiptWith(pr, attempts) {
  let r = createReceipt({ pr, now: NOW });
  for (const [phase, outcome] of attempts) r = appendAttempt(r, { phase, outcome, headSha: HEAD, now: NOW });
  return r;
}
const file = (name, value) => ({ name, text: typeof value === "string" ? value : JSON.stringify(value) });

describe("receiptHealthReport", () => {
  it("counts valid receipts by verdict and valid spot-check logs", () => {
    const report = receiptHealthReport([
      file("pr-1.json", receiptWith(1, [["pre-pr", "pass"], ["stop", "pass"]])),
      file("pr-2.json", receiptWith(2, [["pre-pr", "pass"], ["review-pr", "fail"]])),
      file("pr-3.json", receiptWith(3, [["pre-pr", "pass"]])),
      file(
        "pr-3.spot-checks.json",
        appendSpotCheck(createSpotCheckStore({ pr: 3, now: NOW }), {
          kind: "spot-check",
          headSha: HEAD,
          selected: false,
          reason: "off",
          rate: 0,
          roll: 0.5,
          ci: "available",
          workflow: "test.yml",
          trunk: "main",
          now: NOW,
        }),
      ),
    ]);
    expect(report.receipts).toBe(3);
    expect(report.verdicts).toEqual({ ready: 1, blocked: 1, "in-progress": 1 });
    expect(report.spotCheckLogs).toBe(1);
    expect(report.damaged).toEqual([]);
    expect(report.ignored).toEqual([]);
  });

  it("reports a receipt that is not JSON, names the PR, and does not count it", () => {
    const report = receiptHealthReport([file("pr-7.json", "{not json")]);
    expect(report.receipts).toBe(0);
    expect(report.damaged).toHaveLength(1);
    expect(report.damaged[0]).toMatchObject({ name: "pr-7.json", pr: 7, kind: "receipt" });
    expect(report.damaged[0].problem).toMatch(/not readable JSON/);
  });

  it("reports a receipt whose pr field disagrees with its file name", () => {
    const report = receiptHealthReport([file("pr-8.json", receiptWith(9, []))]);
    expect(report.damaged).toEqual([{ name: "pr-8.json", pr: 8, kind: "receipt", problem: "pr is 9, but the file is for #8" }]);
  });

  it("reports a receipt that a newer or older tool wrote with a key it does not know", () => {
    const report = receiptHealthReport([file("pr-4.json", { ...receiptWith(4, []), spot_checks: [] })]);
    expect(report.damaged[0]).toMatchObject({ pr: 4, kind: "receipt", problem: 'unknown key "spot_checks"' });
  });

  it("reports a damaged spot-check log as its own kind", () => {
    const report = receiptHealthReport([file("pr-5.spot-checks.json", { schema_version: 2 })]);
    expect(report.spotCheckLogs).toBe(0);
    expect(report.damaged).toHaveLength(1);
    expect(report.damaged[0]).toMatchObject({ name: "pr-5.spot-checks.json", pr: 5, kind: "spot-check log" });
  });

  it("ignores files that are not receipts and lists them, sorted", () => {
    const report = receiptHealthReport([file("notes.txt", "x"), file("pr-x.json", "{}"), file("pr-0.json", "{}")]);
    expect(report.receipts).toBe(0);
    expect(report.damaged).toEqual([]);
    expect(report.ignored).toEqual(["notes.txt", "pr-0.json", "pr-x.json"]);
  });

  it("returns an empty report for no files", () => {
    expect(receiptHealthReport([])).toEqual({
      receipts: 0,
      verdicts: { ready: 0, blocked: 0, "in-progress": 0 },
      spotCheckLogs: 0,
      damaged: [],
      ignored: [],
    });
  });

  it("reports a file that could not be read as damaged, under its own name", () => {
    const report = receiptHealthReport([{ name: "pr-6.json", error: "EACCES: permission denied" }, file("pr-1.json", receiptWith(1, []))]);
    expect(report.receipts).toBe(1);
    expect(report.damaged).toEqual([{ name: "pr-6.json", pr: 6, kind: "receipt", problem: "unreadable: EACCES: permission denied" }]);
  });

  it("sorts damaged entries by pull request number", () => {
    const report = receiptHealthReport([file("pr-12.json", "x"), file("pr-3.json", "y")]);
    expect(report.damaged.map((d) => d.pr)).toEqual([3, 12]);
  });
});

describe("readReceiptDir", () => {
  it("returns no files and no error when the directory does not exist", () => {
    expect(readReceiptDir(path.join(makeTmpDir(), "missing"))).toEqual({ files: [], error: null });
  });

  it("reads regular files and skips lock directories", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "pr-1.json"), "{}");
    fs.mkdirSync(path.join(dir, "pr-1.json.lock"));
    const { files, error } = readReceiptDir(dir);
    expect(error).toBeNull();
    expect(files).toEqual([{ name: "pr-1.json", text: "{}" }]);
  });

  it("returns a directory with a receipt name as an unreadable entry and still reads the others", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "pr-1.json"), "{}");
    fs.mkdirSync(path.join(dir, "pr-2.json"));
    const { files, error } = readReceiptDir(dir);
    expect(error).toBeNull();
    expect(files[0]).toEqual({ name: "pr-1.json", text: "{}" });
    expect(files[1].name).toBe("pr-2.json");
    expect(files[1].error).toMatch(/EISDIR/);
  });

  it("follows a symlinked receipt, as pr-stack does", () => {
    const dir = makeTmpDir();
    const target = path.join(makeTmpDir(), "real.json");
    fs.writeFileSync(target, '{"x":1}');
    fs.symlinkSync(target, path.join(dir, "pr-9.json"));
    expect(readReceiptDir(dir).files).toEqual([{ name: "pr-9.json", text: '{"x":1}' }]);
  });

  it("reports an unreadable directory as an error, not as no receipts", () => {
    const dir = makeTmpDir();
    const notADir = path.join(dir, "receipts");
    fs.writeFileSync(notADir, "a file where the directory should be");
    const { files, error } = readReceiptDir(notADir);
    expect(files).toEqual([]);
    expect(error).toMatch(/ENOTDIR|not a directory/i);
  });
});
