#!/usr/bin/env node
/** File-only A2A and OTLP export. Existing files are never overwritten. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, helpText } from "../src/lib/argv.mjs";
import { version } from "../src/index.mjs";
import { a2aTasks, otlpSpans, exportJson } from "../src/export.mjs";
import { listCloneTasks, cloneIdentity } from "../src/task-state.mjs";
import { readReceiptDir } from "../src/receipt-health.mjs";
import { parseDependencyRef } from "../src/work-graph.mjs";
import { readRegistry, registryFile, clonesOf } from "../src/clone-registry.mjs";

function localResolution(tasks) {
  const repos = new Set(tasks.flatMap((t) => t.depends_on).map(parseDependencyRef).filter((r) => r?.kind === "clone-task").map((r) => r.repo));
  const clones = new Map();
  if (!repos.size) return { clones };
  const registry = readRegistry(registryFile());
  for (const repo of repos) {
    const readable = [];
    for (const clone of clonesOf(registry, repo)) {
      try { readable.push({ path: clone, tasks: listCloneTasks(clone).tasks }); }
      catch { process.stderr.write("export: skipped an unreadable registered clone\n"); }
    }
    if (readable.length) clones.set(repo, readable);
  }
  return { clones };
}

const META = { name: "dotbabel-export", synopsis: "dotbabel export --a2a <file> | --otlp <file>", description: "Write a new private JSON file, offline. Existing files are refused.", flags: { a2a: { type: "string" }, otlp: { type: "string" } } };
let code = 64;
try {
  const args = parse(process.argv.slice(2), META.flags);
  if (args.help) { process.stdout.write(helpText(META)); code = 0; }
  else if (args.version) { process.stdout.write(`${version}\n`); code = 0; }
  else {
    if (args.positional.length || Number(!!args.flags.a2a) + Number(!!args.flags.otlp) !== 1) throw new Error("choose exactly one export format and file");
    code = 2;
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    let output;
    if (args.flags.a2a) {
      const listed = listCloneTasks(root);
      for (const problem of listed.problems) process.stderr.write(`export: skipped unreadable task (${problem.split(process.env.TYPESAFE_API_KEY || "\0").join("<redacted>")})\n`);
      output = a2aTasks(listed.tasks, cloneIdentity(root).key ?? root, localResolution(listed.tasks));
    } else {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
      const listed = readReceiptDir(path.join(common, "dotbabel", "receipts"));
      if (listed.error) throw new Error("cannot read receipts");
      output = otlpSpans(listed.files.filter((f) => /^pr-[1-9]\d*\.json$/.test(f.name)).map((f) => {
        if (f.error) throw new Error("cannot read a receipt");
        const receipt = JSON.parse(f.text);
        if (receipt?.pr !== Number(/^pr-(\d+)\.json$/.exec(f.name)[1])) throw new Error("receipt does not match its file");
        return receipt;
      }));
    }
    const text = exportJson(output, [process.env.TYPESAFE_API_KEY]);
    const destination = args.flags.a2a || args.flags.otlp;
    const fd = fs.openSync(destination, "wx", 0o600);
    try { fs.writeFileSync(fd, text); }
    catch (err) { fs.unlinkSync(destination); throw err; }
    finally { fs.closeSync(fd); }
    process.stdout.write("Export written.\n");
    code = 0;
  }
} catch {
  process.stderr.write(code === 64 ? "dotbabel export: choose --a2a <file> or --otlp <file>\n" : "dotbabel export: cannot read state or create the export file; existing files remain unchanged\n");
}
process.exitCode = code;
