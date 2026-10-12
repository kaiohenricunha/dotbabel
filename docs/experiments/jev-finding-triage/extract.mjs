#!/usr/bin/env node
// Extract every /post-pr-review finding in a repository and the /review-pr
// verdict on it, from the pull request review comments. Read-only: one
// paginated `gh api` GET. The output holds review text, file paths and diff
// hunks, so by default it goes to a new private temporary directory, and every
// file this script writes has mode 0600. Never commit it.
//
//   node extract.mjs [--repo owner/name] [--authors login,login] [--labels labels.json]
//                    [--out findings.jsonl] [--dump comments.jsonl]
//                    [--from-dump comments.jsonl] [--hunk-lines 60]
//
// --authors   only comments by these logins count, as findings and as verdict
//             replies. Default: the owner of --repo. With --from-dump and no
//             --repo, --authors is required.
// --labels    a JSON object of hand labels, {"<comment_id>": "valid" |
//             "false_positive" | "unknown"}, that replaces the text-rule verdict.
// --dump      also save every raw review comment, with logins and full hunks.
//
// stdout: the dataset counts as JSON, and the authors of every marker comment
// and reply before the author filter (no review text).
// Exit 0 ok, 2 gh failed or the --from-dump file is unreadable, 64 usage
// (an unknown flag, a bad value, no author allowlist, or a bad labels file).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authorTally, datasetCounts, pairFindings, parseLabels, parsePositiveInt } from "./lib.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

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
    else if (flag === "--hunk-lines") args.hunkLines = parsePositiveInt(flag, value());
    else if (flag === "--labels") args.labels = value();
    else if (flag === "--authors") {
      args.authors = value().split(",").map((a) => a.trim());
      const bad = args.authors.find((a) => !LOGIN.test(a));
      if (bad !== undefined) throw new Error(`--authors holds a value that is not a GitHub login: "${bad}"`);
    } else throw new Error(`unknown flag: ${flag}`);
  }
  if (args.repo !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(args.repo)) {
    throw new Error(`--repo needs owner/name, got "${args.repo}"`);
  }
  if (args.fromDump && !args.repo && !args.authors) {
    throw new Error("--from-dump needs --repo or --authors: only the posting identity's comments count");
  }
  return args;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
}

// Review text stays readable by the owner only.
function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const usage = (message) => {
  process.stderr.write(`extract: ${message}\n`);
  process.exit(64);
};

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  usage(err.message);
}

let labels = new Map();
if (args.labels) {
  try {
    labels = parseLabels(JSON.parse(fs.readFileSync(args.labels, "utf8")));
  } catch (err) {
    usage(`bad labels file ${args.labels}: ${err.message}`);
  }
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
      ".[] | {id, pr: (.pull_request_url | split(\"/\") | last | tonumber), path, line, commit_id, original_commit_id, user: .user.login, in_reply_to_id, body, diff_hunk, created_at}",
    ]);
    if (args.dump) writePrivate(args.dump, text);
    rows = readJsonl(text);
  }
} catch (err) {
  process.stderr.write(`extract: could not read review comments: ${err.message}\n`);
  process.exit(2);
}

let findings;
try {
  findings = pairFindings(rows, { hunkLines: args.hunkLines, repo, authors: args.authors, labels });
} catch (err) {
  usage(err.message);
}
const unused = [...labels.keys()].filter((id) => !findings.some((f) => String(f.comment_id) === id));
if (unused.length) process.stderr.write(`extract: ${unused.length} hand labels match no finding\n`);

const out = args.out ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jev-finding-triage-")), "findings.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });
writePrivate(out, findings.map((f) => JSON.stringify(f)).join("\n") + (findings.length ? "\n" : ""));
process.stderr.write(`extract: ${rows.length} review comments, ${findings.length} findings -> ${out}\n`);
process.stdout.write(`${JSON.stringify({ ...datasetCounts(findings), authors_seen: authorTally(rows) }, null, 2)}\n`);
