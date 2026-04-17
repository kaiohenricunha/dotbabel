# `@dotclaude/dotclaude`

[![npm](https://img.shields.io/npm/v/@dotclaude/dotclaude.svg)](https://www.npmjs.com/package/@dotclaude/dotclaude)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](./CHANGELOG.md)

> Maintained by [@kaiohenricunha](https://github.com/kaiohenricunha) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

Portable Claude Code plugin + zero-dependency npm package that bootstraps
spec-driven-development governance into consumer repos.

**Who is this for?**

| I am…            | I want…                                        | Start here                                       |
| ---------------- | ---------------------------------------------- | ------------------------------------------------ |
| **Dotfile user** | Skills & commands in every Claude Code session | [Clone & bootstrap](#clone--bootstrap)           |
| **Consumer**     | Spec-governance CLI for my own repos           | [Install the CLI](#install-the-cli)              |
| **Library user** | Node API in my own tooling                     | [docs/api-reference.md](./docs/api-reference.md) |
| **Contributor**  | Dev workflow, local gates                      | [CONTRIBUTING.md](./CONTRIBUTING.md)             |

---

## TL;DR — pick your path

| What you want                                     | How                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| Skills & commands library wired into `~/.claude/` | **[Clone & bootstrap](#clone--bootstrap)** — 30 seconds, no npm required  |
| Spec-governance CLI for your own repos            | **[Install the CLI](#install-the-cli)** — `npm i -g @dotclaude/dotclaude` |

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

If you have the CLI installed, you can use it instead of the shell scripts:

```bash
dotclaude bootstrap             # same as ./bootstrap.sh
dotclaude sync pull             # same as ./sync.sh pull
dotclaude sync push             # same as ./sync.sh push
dotclaude sync status           # show installed vs latest version
```

Both `bootstrap` and `sync` support `--source <path>` (clone mode) or default
to the npm package installation (npm mode). Run `dotclaude bootstrap --help`
or `dotclaude sync --help` for full options.

### What you get

26 skills and commands are wired into every Claude Code session:

**Cloud & IaC specialists** — activate automatically when you mention the relevant technology:

| Skill                   | Triggers on                                     | What it does                                                           |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `aws-specialist`        | "AWS", "IAM role", "Lambda", "ECS", "S3"…       | Deep-dive AWS architecture review, IAM audits, multi-service debugging |
| `azure-specialist`      | "Azure", "AKS", "Managed Identity", "Bicep"…    | Azure workload review, identity audits, ARM/Bicep guidance             |
| `gcp-specialist`        | "GCP", "GKE", "Cloud Run", "Workload Identity"… | GCP architecture review, IAM hierarchy, serverless guidance            |
| `kubernetes-specialist` | "kubernetes", "k8s", "pod", "helm chart"…       | Cluster troubleshooting, workload design, network policy review        |
| `crossplane-specialist` | "Crossplane", "XRD", "Composition", "Claim"…    | XRD design, Composition correctness, provider config audit             |
| `terraform-specialist`  | "Terraform", "state file", "IaC module"…        | Module design, state management, workspace review                      |
| `terragrunt-specialist` | "Terragrunt", "run-all", "DRY Terraform"…       | DRY hierarchy review, dependency graph, env layout                     |
| `pulumi-specialist`     | "Pulumi", "ComponentResource", "stack"…         | Stack review, Automation API audit, secrets management                 |

**Engineering workflow** — slash commands:

| Command            | Invoke                    | What it does                                      |
| ------------------ | ------------------------- | ------------------------------------------------- |
| `git`              | `/git`                    | Conventional commits, PR creation, branch naming  |
| `changelog`        | `/changelog`              | Generate changelog entry from git history         |
| `merge-pr`         | `/merge-pr <N>`           | Full local verification gate before merge         |
| `review-pr`        | `/review-pr <N>`          | Fetch comments, apply fixes, resolve threads      |
| `audit-and-fix`    | `/audit-and-fix <domain>` | Audit → cluster findings → spawn parallel fix PRs |
| `dependabot-sweep` | `/dependabot-sweep`       | Batch-triage all open Dependabot PRs              |

**Debugging & quality:**

| Command             | Invoke                       | What it does                                   |
| ------------------- | ---------------------------- | ---------------------------------------------- |
| `ground-first`      | `/ground-first <subject>`    | Code-grounded analysis before any edit         |
| `fix-with-evidence` | `/fix-with-evidence <issue>` | Reproduce → Fix → Verify → PR loop             |
| `detect-flaky`      | `/detect-flaky <test-cmd>`   | Find and fix flaky tests by repeated execution |
| `security-review`   | `/security-review`           | Scan changed files for OWASP vulnerabilities   |

**Analysis & documentation:**

| Command             | Invoke                         | What it does                                              |
| ------------------- | ------------------------------ | --------------------------------------------------------- |
| `create-audit`      | `/create-audit <subject>`      | Evidence-based audit doc → `docs/audits/`                 |
| `create-inspection` | `/create-inspection <problem>` | Investigate and surface fix options → `docs/inspections/` |
| `create-assessment` | `/create-assessment <target>`  | 0–10 graded assessment doc → `docs/assessments/`          |
| `markdown`          | `/markdown <path>`             | Fix markdown formatting and structure                     |

**Spec & governance:**

| Command / Skill  | Invoke                                                                                                                                | What it does                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `spec`           | `/spec <id> "<title>"`                                                                                                                | Interactive spec authoring → `docs/specs/`      |
| `validate-spec`  | `/validate-spec <id>`                                                                                                                 | Audit an implemented spec against the codebase  |
| `agents-search`  | `/agents-search list`                                                                                                                 | Discover, search, and manage Claude Code agents |
| `veracity-audit` | `/veracity-audit audit --config <config> --quality-config <quality-config> --pipeline-dir <pipeline-dir> --scoring-dir <scoring-dir>` | Audit a data pipeline for veracity and value    |

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
```

Every command is context-aware — it reads your repo's files, history, and CI state.

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
dotclaude bootstrap                # set up (or refresh) ~/.claude/ — symlinks commands, skills, CLAUDE.md
dotclaude sync pull                # pull latest dotclaude version and re-bootstrap
dotclaude sync push                # secret-scan staged files, commit, and push (clone mode)
dotclaude sync status              # show installed vs latest version / git status
dotclaude doctor                   # self-diagnostic: env, facts, manifest, specs, bootstrap
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

Shell-level hardening ([SEC-1..4, OPS-1..2](./docs/cli-reference.md#hardening-contract)) is enforced at
[`plugins/dotclaude/scripts/validate-settings.sh`](./plugins/dotclaude/scripts/validate-settings.sh);
its 12-case behavioral suite at
[`plugins/dotclaude/tests/test_validate_settings.sh`](./plugins/dotclaude/tests/test_validate_settings.sh)
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
