#!/usr/bin/env node
// auto-update-manifest.mjs — thin pre-commit wrapper.
// Invokes harness-validate-skills --update from the package bin,
// using the current working directory as repo root.

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, '..', 'bin', 'harness-validate-skills.mjs');

try {
  execFileSync(process.execPath, [bin, '--update'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
