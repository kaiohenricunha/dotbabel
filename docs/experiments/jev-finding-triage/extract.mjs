#!/usr/bin/env node
// Extract every /post-pr-review finding in a repository and the /review-pr
// verdict on it, from the pull request review comments. Read-only: one
// paginated `gh api` GET. The output holds review text and diff hunks, so it
// goes to a temporary directory by default. Never commit it.
//
//   node extract.mjs [--repo owner/name] [--out findings.jsonl] [--dump comments.jsonl]
//                    [--from-dump comments.jsonl] [--hunk-lines 60]
//
// stdout: the dataset counts as JSON (no review text). Exit 0 ok, 2 gh failed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { datasetCounts, pairFindings } from "./lib.mjs";

function parseArgs(argv) {
  const args = { hunkLines: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === "--repo") args.repo = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--dump") args.dump = value();
    else if (flag === "--from-dump") args.fromDump = value();
    else if (flag === "--hunk-lines") args.hunkLines = Number(value());
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
}

function readJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`extract: ${err.message}\n`);
  process.exit(64);
}

let rows;
let repo = args.repo ?? "unknown";
try {
  if (args.fromDump) {
    rows = readJsonl(fs.readFileSync(args.fromDump, "utf8"));
  } else {
    if (!args.repo) repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    const text = gh([
      "api",
      "--paginate",
      `repos/${repo}/pulls/comments?per_page=100`,
      "--jq",
      ".[] | {id, pr: (.pull_request_url | split(\"/\") | last | tonumber), path, user: .user.login, in_reply_to_id, body, diff_hunk, created_at}",
    ]);
    if (args.dump) fs.writeFileSync(args.dump, text);
    rows = readJsonl(text);
  }
} catch (err) {
  process.stderr.write(`extract: could not read review comments: ${err.message}\n`);
  process.exit(2);
}

const findings = pairFindings(rows, { hunkLines: args.hunkLines, repo });
const out = args.out ?? path.join(os.tmpdir(), "jev-finding-triage", "findings.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, findings.map((f) => JSON.stringify(f)).join("\n") + (findings.length ? "\n" : ""));
process.stderr.write(`extract: ${rows.length} review comments, ${findings.length} findings -> ${out}\n`);
process.stdout.write(`${JSON.stringify(datasetCounts(findings), null, 2)}\n`);
