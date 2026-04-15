# `@dotclaude/dotclaude`

[![npm](https://img.shields.io/npm/v/@dotclaude/dotclaude.svg)](https://www.npmjs.com/package/@dotclaude/dotclaude)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](./CHANGELOG.md)

Portable Claude Code plugin + zero-dependency npm package that bootstraps
spec-driven-development governance into consumer repos.

---

## TL;DR — pick your path

| What you want | How |
| --- | --- |
| Skills & commands library wired into `~/.claude/` | **[Clone & bootstrap](#clone--bootstrap)** — 30 seconds, no npm required |
| Spec-governance CLI for your own repos | **[Install the CLI](#install-the-cli)** — `npm i -g @dotclaude/dotclaude` |

Both paths are independent. You can use one or both.

---

## Clone & bootstrap

Just want the skills library, commands, and a global CLAUDE.md? Three lines:

```bash
git clone https://github.com/kaiohenricunha/dotclaude.git ~/projects/dotclaude
cd ~/projects/dotclaude
./bootstrap.sh          # symlinks commands/ + skills/ + CLAUDE.md into ~/.claude/
```

That's it — the full skills and commands library is now available in every
Claude Code session. To stay current:

```bash
./sync.sh pull          # pull + re-bootstrap
./sync.sh push          # secret-scan + commit + push
```

See [CLAUDE.md](./CLAUDE.md) for the global rules this installs.

---

## Install the CLI

Need spec-governance gates, CI integration, drift detection, or programmatic
validation in your own projects? Install the CLI:

```bash
# Global — use dotclaude anywhere
npm install -g @dotclaude/dotclaude

# Per-project — pin it to a repo (useful for CI)
npm install -D @dotclaude/dotclaude
```

Then use the umbrella dispatcher or standalone bins interchangeably:

```bash
dotclaude doctor                   # self-diagnostic: env, facts, manifest, specs
dotclaude validate-skills          # verify skills manifest checksums + DAG
dotclaude validate-specs           # audit spec contracts + dependency cycles
dotclaude check-spec-coverage      # PR gate: protected paths must be spec-backed
dotclaude check-instruction-drift  # detect stale CLAUDE.md / README entries
dotclaude detect-drift             # flag commands diverged from origin/main 14+ days
dotclaude init                     # scaffold specs, hooks, manifest into a repo
```

Every subcommand also works as a standalone bin — `npx dotclaude-doctor`,
`npx dotclaude-validate-specs`, etc. All support `--help`, `--version`,
`--json`, `--verbose`, `--no-color`.

Five-minute walkthrough: [docs/quickstart.md](./docs/quickstart.md).

### Scaffold a repo

```bash
npx dotclaude-init --project-name my-project --project-type node
npx dotclaude-doctor          # verify everything wired up
npx dotclaude-validate-specs  # run first governance check
```

### Node API

```js
import {
  createHarnessContext,
  validateSpecs,
  validateManifest,
  checkSpecCoverage,
  checkInstructionDrift,
  scaffoldHarness,
  ValidationError,
  ERROR_CODES,
  EXIT_CODES,
} from "@dotclaude/dotclaude";

const ctx = createHarnessContext(); // resolves repo root via git
const { ok, errors } = validateSpecs(ctx); // errors are ValidationError instances
if (!ok) {
  for (const err of errors) {
    if (err.code === ERROR_CODES.SPEC_STATUS_INVALID) {
      // programmatic reaction to a specific failure class
    }
  }
  process.exit(EXIT_CODES.VALIDATION);
}
```

Full contract: [docs/api-reference.md](./docs/api-reference.md).

### CLI exit codes

Every bin honors `--help`, `--version`, `--json`, `--verbose`, `--no-color` and exits with:

| Code | Name       | Meaning                                                |
| ---- | ---------- | ------------------------------------------------------ |
| 0    | OK         | Success                                                |
| 1    | VALIDATION | Rule failure (expected failure mode)                   |
| 2    | ENV        | Misconfigured environment                              |
| 64   | USAGE      | Bad CLI invocation (matches BSD `sysexits.h EX_USAGE`) |

Per-bin details: [docs/cli-reference.md](./docs/cli-reference.md).

---

## Hardening decisions

Each row links to its ADR (see [docs/adr/](./docs/adr/)):

| Decision                                 | ADR                                                     |
| ---------------------------------------- | ------------------------------------------------------- |
| Monorepo dual-persona layout             | [0001](./docs/adr/0001-monorepo-dual-persona-layout.md) |
| No TypeScript; JSDoc + zero runtime deps | [0002](./docs/adr/0002-no-typescript.md)                |
| Structured `ValidationError` contract    | [0012](./docs/adr/0012-structured-error-contract.md)    |
| Exit-code convention `{0,1,2,64}`        | [0013](./docs/adr/0013-exit-code-convention.md)         |
| CLI ✓/✗/⚠ output format                  | [0014](./docs/adr/0014-cli-tick-cross-warn-format.md)   |

Shell-level hardening (SEC-1..4, OPS-1..2) is enforced today at
`plugins/dotclaude/scripts/validate-settings.sh`; its 12-case behavioral
suite at `plugins/dotclaude/tests/test_validate_settings.sh` pins every
contract.

---

## Further reading

|                                                      |                                             |
| ---------------------------------------------------- | ------------------------------------------- |
| [docs/index.md](./docs/index.md)                     | Nav map with persona-tailored entry points  |
| [docs/quickstart.md](./docs/quickstart.md)           | Install → scaffold → first green validator  |
| [docs/cli-reference.md](./docs/cli-reference.md)     | Every bin, flag, exit code, `--json` schema |
| [docs/api-reference.md](./docs/api-reference.md)     | Node API surface                            |
| [docs/architecture.md](./docs/architecture.md)       | Layer diagram + PR-time sequence            |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | Error-code → remediation index              |
| [docs/upgrade-guide.md](./docs/upgrade-guide.md)     | 0.1 → 0.2 migration, forking                |
| [docs/personas.md](./docs/personas.md)               | Who reads which file                        |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                 | Dev workflow + local gates                  |
| [SECURITY.md](./SECURITY.md)                         | Private vulnerability disclosure            |
| [CHANGELOG.md](./CHANGELOG.md)                       | Keep-a-Changelog history                    |

## License

MIT — see [LICENSE](./LICENSE).
