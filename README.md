# `@kaiohenricunha/dotclaude`

[![npm](https://img.shields.io/npm/v/@kaiohenricunha/dotclaude.svg)](https://www.npmjs.com/package/@kaiohenricunha/dotclaude)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](./CHANGELOG.md)

Portable Claude Code plugin + zero-dependency npm package that bootstraps
spec-driven-development governance into consumer repos. Ships a structured-error
CLI, an umbrella `dotclaude` dispatcher, seven standalone bins, a destructive-git
PreToolUse hook, and a gold-standard shell settings validator.

**Two personas live in this repo** (by design — see [docs/personas.md](./docs/personas.md)):

- The **npm package** under `plugins/dotclaude/` (what consumers install).
- **Personal dotfiles** at the top level (symlinked into `~/.claude/` via `bootstrap.sh` — fork this to use your own).

If you're installing the package, ignore the top-level scripts —
`package.json.files` excludes them from the tarball.

---

## Consumer quickstart

```bash
npm i -D @kaiohenricunha/dotclaude
npx dotclaude-init --project-name my-project --project-type node
npx dotclaude-doctor          # self-diagnostic
npx dotclaude-validate-specs  # every bin works standalone or via `npx dotclaude <sub>`
```

Five minutes end-to-end: [docs/quickstart.md](./docs/quickstart.md).

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
} from "@kaiohenricunha/dotclaude";

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

### CLI contract

Every bin honors `--help`, `--version`, `--json`, `--verbose`, `--no-color` and exits with the named enum:

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

## Personal dotfiles persona

Fork this repo and use it as your own Claude Code dotfiles:

```bash
git clone https://github.com/kaiohenricunha/dotclaude.git ~/projects/dotclaude
cd ~/projects/dotclaude
./bootstrap.sh                  # symlinks commands/ + skills/ + CLAUDE.md into ~/.claude/
./sync.sh pull                  # pull + re-bootstrap
./sync.sh push                  # secret-scan + commit + push
```

See [CLAUDE.md](./CLAUDE.md) for the global rules this installs.

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
