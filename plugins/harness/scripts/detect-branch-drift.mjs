#!/usr/bin/env node
// detect-branch-drift.mjs — walk .claude/commands/*.md on HEAD,
// diff each against origin/main, report a table. Exit 1 if any file
// has diverged AND its last-main-commit is >14 days old.

import { execFileSync } from 'child_process';

const DAY_S = 86400;
const STALE_DAYS = 14;

function exec(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

// Parse --repo-root flag
const args = process.argv.slice(2);
let repoRoot;
const flagIdx = args.indexOf('--repo-root');
if (flagIdx !== -1) {
  repoRoot = args[flagIdx + 1];
} else {
  repoRoot = exec('git', ['rev-parse', '--show-toplevel'], process.cwd());
}

if (!repoRoot) {
  console.error('Could not determine repo root. Use --repo-root <path>.');
  process.exit(2);
}

// List .claude/commands/*.md files tracked on HEAD
const lsTree = exec('git', ['ls-tree', '-r', '--name-only', 'HEAD', '.claude/commands/'], repoRoot);
const files = lsTree.split('\n').filter(f => f.endsWith('.md'));

if (files.length === 0) {
  console.log('no drift detected (no .claude/commands/*.md on HEAD)');
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const rows = [];
let anyStale = false;

for (const file of files) {
  const diff = exec('git', ['diff', 'origin/main', '--', file], repoRoot);
  const diverged = diff.length > 0;

  let daysBehind = 0;
  if (diverged) {
    const tsStr = exec('git', ['log', '-1', '--format=%ct', 'origin/main', '--', file], repoRoot);
    const ts = parseInt(tsStr, 10);
    if (!isNaN(ts) && ts > 0) {
      daysBehind = Math.floor((now - ts) / DAY_S);
    }
    if (daysBehind > STALE_DAYS) anyStale = true;
  }

  rows.push({ file, diverged, daysBehind });
}

const anyDiverged = rows.some(r => r.diverged);
if (!anyDiverged) {
  console.log('no drift detected');
  process.exit(0);
}

// Print table
const header = `${'FILE'.padEnd(50)} ${'DIVERGED'.padEnd(10)} DAYS-BEHIND-MAIN`;
console.log(header);
console.log('-'.repeat(header.length));
for (const r of rows) {
  const name = r.file.padEnd(50);
  const div  = (r.diverged ? 'yes' : 'no').padEnd(10);
  const days = r.diverged ? String(r.daysBehind) : '-';
  console.log(`${name} ${div} ${days}`);
}

process.exit(anyStale ? 1 : 0);
