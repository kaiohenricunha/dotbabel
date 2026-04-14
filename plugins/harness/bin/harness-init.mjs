#!/usr/bin/env node
import { fileURLToPath } from "url";
import path from "path";
import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argv parsing (no external deps) ────────────────────────────────────────

const args = process.argv.slice(2);

function flagValue(flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  if (idx + 1 >= args.length || args[idx + 1].startsWith("--")) return null;
  return args[idx + 1];
}

const force = args.includes("--force");

// --project-name: required, defaults to basename(cwd)
let projectName = flagValue("--project-name") ?? path.basename(process.cwd());
if (projectName === null) {
  console.error("Error: --project-name requires a value.");
  process.exit(64);
}

// --project-type: optional, defaults to "unknown"
const projectTypeRaw = flagValue("--project-type");
if (projectTypeRaw === null) {
  console.error("Error: --project-type requires a value.");
  process.exit(64);
}
const projectType = projectTypeRaw ?? "unknown";

// ── Resolve paths ───────────────────────────────────────────────────────────

const templatesDir = path.resolve(__dirname, "..", "templates");
const targetDir = process.cwd();
const today = new Date().toISOString().slice(0, 10);

// ── Run scaffolder ──────────────────────────────────────────────────────────

try {
  const { filesWritten } = scaffoldHarness(
    {
      templatesDir,
      targetDir,
      placeholders: { project_name: projectName, project_type: projectType, today },
    },
    { force }
  );

  console.log(`Harness initialized in ${targetDir}`);
  console.log(`Files written (${filesWritten.length}):`);
  for (const f of filesWritten) {
    console.log(`  ${f}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
