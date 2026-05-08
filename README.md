# `@dotbabel/dotbabel`

[![npm](https://img.shields.io/npm/v/@dotbabel/dotbabel.svg)](https://www.npmjs.com/package/@dotbabel/dotbabel)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](./CHANGELOG.md)

> Maintained by [@kaiohenricunha](https://github.com/kaiohenricunha) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

An opinionated, model-agnostic governance toolkit for Claude Code, Codex,
Gemini CLI, Copilot CLI, and other agentic CLIs. Ships a curated library of
skills, slash commands, and cloud/IaC specialists plus a global rule floor
that hardens every agent session — and an optional spec-driven-development
governance CLI on top, for repos that want PR-time gates.

**Who is this for?**

| I am…            | I want…                                                                          | Start here                                       |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Dotfile user** | The toolkit — skills, commands, and CLAUDE.md in every Claude session            | [Clone & bootstrap](#clone--bootstrap)           |
| **Consumer**     | The CLI in my repo — bootstrap, doctor, drift detection, optional spec-gov gates | [Install the CLI](#install-the-cli)              |
| **Library user** | Node API in my own tooling                                                       | [docs/api-reference.md](./docs/api-reference.md) |
| **Contributor**  | Dev workflow, local gates                                                        | [CONTRIBUTING.md](./CONTRIBUTING.md)             |

---

## TL;DR — pick your path

| What you want                                                                | How                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skills & commands library wired into `~/.claude/`                            | **[Clone & bootstrap](#clone--bootstrap)** — 30 seconds, no npm required           |
| Governance CLI for your own repos (bootstrap + doctor + optional spec gates) | **[Install the CLI](#install-the-cli)** — see install section (Node ≥ 20 required) |

Both paths are independent. You can use one or both.

---

## Clone & bootstrap

Just want the skills library, commands, and a global CLAUDE.md? Three lines:

```bash
git clone https://github.com/kaiohenricunha/dotbabel.git ~/projects/dotbabel
cd ~/projects/dotbabel
./bootstrap.sh          # symlinks commands/ + skills/ + CLAUDE.md into ~/.claude/
```

That's it — the full skills and commands library is now available in every
Claude Code session. To stay current:

```bash
./sync.sh pull          # pull + re-bootstrap
./sync.sh push          # secret-scan + commit + push
```

If you have the CLI installed, you can use it instead of the shell scripts:

```bash
dotbabel bootstrap             # same as ./bootstrap.sh
dotbabel sync pull             # same as ./sync.sh pull
dotbabel sync push             # same as ./sync.sh push
dotbabel sync status           # show installed vs latest version
```

Both `bootstrap` and `sync` support `--source <path>` (clone mode) or default
to the npm package installation (npm mode). Run `dotbabel bootstrap --help`
or `dotbabel sync --help` for full options.

### What you get

The bootstrap wires the authored library into every Claude Code session:

- `skills/` provides reusable workflows and specialists. Skills can be invoked
  directly with `/skill-name` and can also activate from natural-language
  requests when their metadata matches.
- `commands/` keeps the existing explicit slash-command prompt templates for
  workflows such as `/ground-first`, `/fix-with-evidence`, and `/pre-pr`.
- `agents/` provides specialized Claude Code subagents copied during bootstrap.
- `CLAUDE.md` provides the global rule floor for every session.

Do not treat this README as the catalog. The source-of-truth inventory is
generated from artifact frontmatter under [`index/`](index/), checked in CI
with `dotbabel index --check`, and explained in
[`docs/taxonomy.md`](docs/taxonomy.md).

```bash
dotbabel list --type skill
dotbabel list --type command
dotbabel search handoff
dotbabel show handoff --type skill
dotbabel index --check
```

See [CLAUDE.md](./CLAUDE.md) for the global rules this installs.

---

## Quick taste

After `./bootstrap.sh`, open any repo in Claude Code and try:

```
# Understand existing code before touching it
/ground-first auth token refresh race condition
# → grounded analysis with file:line citations, no edits proposed

# Fix a reported bug with a full evidence loop
/fix-with-evidence 140
# → reproduces the issue, fixes it, verifies, opens a PR

# Get a deep AWS IAM review of this repo
/aws-specialist review IAM policies in the production account
# → structured review: least-privilege gaps, trust-policy findings, remediations

# Batch-triage all open Dependabot PRs
/dependabot-sweep
# → parallel subagents annotate each PR with risk level; safe bumps merged automatically

# Hand off mid-task context across CLIs or machines
/handoff <query>                    # local cross-agent: emit <handoff> block
/handoff push [<query>] [--tag]     # upload to transport (scrubs secrets)
/handoff pull [<query>]             # fetch and render on the other end
# <query> = short UUID, full UUID, 'latest', Claude customTitle, or Codex thread_name
```

These workflows are context-aware: they read your repo's files, history, and CI state.

---

## Install the CLI

Want the governance CLI in your own repos — bootstrap, doctor, drift detection,
programmatic validation, and optional spec-governance gates? Install it:

```bash
# One-liner (requires Node ≥ 20)
curl -fsSL https://raw.githubusercontent.com/kaiohenricunha/dotbabel/main/install.sh | bash
```

Or install manually:

```bash
# Global — use dotbabel anywhere
npm install -g @dotbabel/dotbabel

# Per-project — pin it to a repo (useful for CI)
npm install -D @dotbabel/dotbabel
```

The one-liner installs the package globally and runs `dotbabel bootstrap` to
wire `~/.claude/` automatically. To pin a version or skip the bootstrap step:

```bash
curl -fsSL https://raw.githubusercontent.com/kaiohenricunha/dotbabel/main/install.sh | DOTBABEL_VERSION=0.4.0 bash
curl -fsSL https://raw.githubusercontent.com/kaiohenricunha/dotbabel/main/install.sh | DOTBABEL_SKIP_BOOTSTRAP=1 bash
```

Then use the umbrella dispatcher or standalone bins interchangeably:

```bash
dotbabel bootstrap                # set up (or refresh) ~/.claude/ — symlinks commands, skills, CLAUDE.md
dotbabel bootstrap --all          # also force Copilot/Codex/Gemini instruction symlinks
dotbabel sync pull                # pull latest dotbabel version and re-bootstrap
dotbabel sync push                # secret-scan staged files, commit, and push (clone mode)
dotbabel sync status              # show installed vs latest version / git status
dotbabel doctor                   # self-diagnostic: env, facts, manifest, specs, bootstrap
dotbabel doctor --install-hooks   # install pre-commit freshness check for generated instructions
dotbabel validate-skills          # verify skills manifest checksums + DAG
dotbabel validate-specs           # audit spec contracts + dependency cycles
dotbabel check-spec-coverage      # PR gate: protected paths must be spec-backed
dotbabel check-instruction-drift  # detect stale CLAUDE.md / README entries
dotbabel check-instructions-fresh # verify generated cross-CLI instruction files are fresh
dotbabel check-instruction-parity # verify applicable headings are preserved per CLI
dotbabel detect-drift             # flag commands diverged from origin/main 14+ days
dotbabel init                     # scaffold specs, hooks, manifest into a repo
```

Every subcommand also works as a standalone bin — `npx dotbabel-doctor`,
`npx dotbabel-validate-specs`, etc. All support `--help`, `--version`,
`--json`, `--verbose`, `--no-color`.

Five-minute walkthrough: [docs/quickstart.md](./docs/quickstart.md).

### Scaffold a repo

```bash
npx dotbabel-init --project-name my-project --project-type node
npx dotbabel-doctor          # verify everything wired up
npx dotbabel-validate-specs  # run first governance check
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
} from "@dotbabel/dotbabel";

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

Shell-level hardening ([SEC-1..4, OPS-1..2](./docs/cli-reference.md#hardening-contract)) is enforced at
[`plugins/dotbabel/scripts/validate-settings.sh`](./plugins/dotbabel/scripts/validate-settings.sh);
its 12-case behavioral suite at
[`plugins/dotbabel/tests/test_validate_settings.sh`](./plugins/dotbabel/tests/test_validate_settings.sh)
pins every contract.

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
