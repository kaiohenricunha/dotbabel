#!/usr/bin/env node
// Build one Jev request per finding, and send them only when told to.
//
//   node replay.mjs --in findings.jsonl [--limit N] [--primary-only] [--resume --out answers.jsonl]
//       Dry run (the default): print each request it would send as JSONL on
//       stdout, and a size and cost estimate on stderr. Sends nothing. stdout
//       holds review text, file paths and diff hunks: redirect it to a file
//       outside the repository.
//
//   TYPESAFE_API_KEY=... node replay.mjs --in findings.jsonl --send --out answers.jsonl
//       Sends review text, file paths and diff hunks to api.typesafe.ai, a
//       third party. Needs both --send and the key. Get the owner's approval
//       first. A 429, a 5xx, a timeout or a network error is retried with
//       backoff, and a Retry-After header is honored. --out must not exist yet.
//
//   ... --send --resume --out answers.jsonl
//       Send only the findings that have no usable answer in answers.jsonl, and
//       append to it. A usable answer has no error and a noul in [0, 1].
//
// --limit N keeps the first N findings after the other filters; N must be a
// positive integer.
//
// Exit 0 ok (every request sent has a usable answer, or a dry run), 1 some
// requests failed or have no usable answer (run again with --resume), 2 the key
// is missing for --send, 64 usage.

import fs from "node:fs";

import {
  JEV_ENDPOINT,
  buildRequest,
  estimateTokens,
  isPrimary,
  isUsableAnswer,
  latestAnswers,
  parsePositiveInt,
  sendAll,
} from "./lib.mjs";

const PRICE_PER_MILLION = [0.042, 0.084]; // USD per million input tokens; output is free

function parseArgs(argv) {
  const args = { send: false, primaryOnly: false, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === "--in") args.in = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--limit") args.limit = parsePositiveInt(flag, value());
    else if (flag === "--send") args.send = true;
    else if (flag === "--resume") args.resume = true;
    else if (flag === "--primary-only") args.primaryOnly = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.in) throw new Error("--in <findings.jsonl> is required");
  if (args.send && !args.out) throw new Error("--send needs --out <answers.jsonl>");
  if (args.resume && !args.out) throw new Error("--resume needs --out <answers.jsonl>");
  return args;
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const usage = (message) => {
  process.stderr.write(`replay: ${message}\n`);
  process.exit(64);
};

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  usage(err.message);
}

const outExists = args.out !== undefined && fs.existsSync(args.out) && fs.statSync(args.out).size > 0;
if (args.send && outExists && !args.resume) {
  usage(`${args.out} already has answers: pass --resume to send only the findings without a usable answer`);
}

let findings = readJsonl(args.in);
if (args.primaryOnly) findings = findings.filter(isPrimary);
let answered = 0;
if (args.resume && outExists) {
  const usable = new Set(
    [...latestAnswers(readJsonl(args.out)).values()].filter(isUsableAnswer).map((a) => a.comment_id),
  );
  const before = findings.length;
  findings = findings.filter((f) => !usable.has(f.comment_id));
  answered = before - findings.length;
}
if (args.limit !== undefined) findings = findings.slice(0, args.limit);

const bodies = findings.map((f) => JSON.stringify(buildRequest(f)));
const tokens = bodies.reduce((sum, b) => sum + estimateTokens(b), 0);
const cost = PRICE_PER_MILLION.map((p) => ((tokens / 1e6) * p).toFixed(4));
const resumed = args.resume ? `, ${answered} already answered` : "";
const summary = `replay: ${findings.length} requests${resumed}, about ${tokens} input tokens, about $${cost[0]}-$${cost[1]}`;

if (!args.send) {
  for (const body of bodies) {
    const request = {
      method: "POST",
      url: JEV_ENDPOINT,
      headers: { Authorization: "Bearer $TYPESAFE_API_KEY", "Content-Type": "application/json" },
      body: JSON.parse(body),
    };
    process.stdout.write(`${JSON.stringify(request)}\n`);
  }
  process.stderr.write(`${summary} (dry run: nothing sent)\n`);
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  process.stderr.write("replay: --send needs TYPESAFE_API_KEY in the environment\n");
  process.exit(2);
}

process.stderr.write(
  `replay: WARNING: this uploads ${findings.length} review findings, file paths and diff hunks to ${JEV_ENDPOINT}, a third party.\n`,
);
process.stderr.write(`${summary}\n`);
fs.appendFileSync(args.out, "", { mode: 0o600 });
let failed = 0;
await sendAll(findings, {
  fetchImpl: fetch,
  apiKey,
  onResult: (record) => {
    if (!isUsableAnswer(record)) failed += 1;
    fs.appendFileSync(args.out, `${JSON.stringify(record)}\n`);
  },
});
process.stderr.write(`replay: done, ${findings.length - failed} answered, ${failed} failed -> ${args.out}\n`);
if (failed > 0) {
  process.stderr.write("replay: run again with --resume to send only the failed findings\n");
  process.exit(1);
}
