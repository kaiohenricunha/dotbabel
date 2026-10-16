#!/usr/bin/env node
/** Persistent local peer pairing, messages, and Advisor mailbox. */
import { runPeer } from "../src/peer/cli.mjs";
process.exitCode = await runPeer(process.argv.slice(2));
