#!/usr/bin/env node
// Build one Jev request per finding, and send them only when told to.
//
//   node replay.mjs --in findings.jsonl [--limit N] [--primary-only]
//       Dry run (the default): print each request it would send as JSONL on
//       stdout, and a size and cost estimate on stderr. Sends nothing.
//
//   TYPESAFE_API_KEY=... node replay.mjs --in findings.jsonl --send --out answers.jsonl
//       Sends review text and diff hunks to api.typesafe.ai, a third party.
//       Needs both --send and the key. Get the owner's approval first.
//
// Exit 0 ok, 2 the key is missing for --send, 64 usage.

import fs from "node:fs";

import { JEV_ENDPOINT, buildRequest, estimateTokens, sendAll } from "./lib.mjs";

const PRICE_PER_MILLION = [0.042, 0.084]; // USD per million input tokens; output is free

function parseArgs(argv) {
  const args = { send: false, primaryOnly: false };
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
    else if (flag === "--limit") args.limit = Number(value());
    else if (flag === "--send") args.send = true;
    else if (flag === "--primary-only") args.primaryOnly = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.in) throw new Error("--in <findings.jsonl> is required");
  if (args.send && !args.out) throw new Error("--send needs --out <answers.jsonl>");
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`replay: ${err.message}\n`);
  process.exit(64);
}

let findings = fs
  .readFileSync(args.in, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (args.primaryOnly) findings = findings.filter((f) => !f.mechanical && f.verdict !== "unknown");
if (Number.isInteger(args.limit)) findings = findings.slice(0, args.limit);

const bodies = findings.map((f) => JSON.stringify(buildRequest(f)));
const tokens = bodies.reduce((sum, b) => sum + estimateTokens(b), 0);
const cost = PRICE_PER_MILLION.map((p) => ((tokens / 1e6) * p).toFixed(4));
const summary = `replay: ${findings.length} requests, about ${tokens} input tokens, about $${cost[0]}-$${cost[1]}`;

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
  `replay: WARNING: this uploads ${findings.length} review findings and diff hunks to ${JEV_ENDPOINT}, a third party.\n`,
);
process.stderr.write(`${summary}\n`);
fs.writeFileSync(args.out, "");
let failed = 0;
await sendAll(findings, {
  fetchImpl: fetch,
  apiKey,
  onResult: (record) => {
    if (record.error) failed += 1;
    fs.appendFileSync(args.out, `${JSON.stringify(record)}\n`);
  },
});
process.stderr.write(`replay: done, ${findings.length - failed} answered, ${failed} failed -> ${args.out}\n`);
