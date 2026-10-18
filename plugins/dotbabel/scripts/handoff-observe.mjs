#!/usr/bin/env node
/** Internal file-only observation bridge for handoff-extract.sh. */
import { observeTranscript } from "../src/model-intelligence/observe/handoff.mjs";
const [runtimeId, file] = process.argv.slice(2);
if (!runtimeId || !file || process.argv.length !== 4) { process.stderr.write("Usage: handoff-observe.mjs <runtime> <transcript>\n"); process.exitCode = 64; }
else process.stdout.write(JSON.stringify(await observeTranscript(runtimeId, file)) + "\n");
