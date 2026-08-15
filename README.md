# `@dotbabel/dotbabel`

[![npm](https://img.shields.io/npm/v/@dotbabel/dotbabel.svg)](https://www.npmjs.com/package/@dotbabel/dotbabel)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange.svg)](./CHANGELOG.md)

> Maintained by [@kaiohenricunha](https://github.com/kaiohenricunha) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

**Make an AI coding agent show its work.**

Agents produce plausible output fast. The expensive failures come from the
plausible-but-unverified kind: a fix for a bug nobody reproduced, an analysis
citing a file that was never opened, a "done" that no test covers. dotbabel is
the verification layer — a library of skills that force an agent to ground
every claim, plus gates that check the result before it merges.

The skills encode the discipline. `/ground-first` refuses to propose an edit
until the relevant source has actually been read. `/fix-with-evidence` demands
a failing reproduction before a fix and a passing run after it.
`/veracity-audit` and `/plan-grader` grade work against what the code really
says. `/security-review`, `/detect-flaky`, and `/validate-spec` gate the
output. Cloud and IaC specialists (`aws`, `gcp`, `azure`, `kubernetes`,
`terraform`, `crossplane`) bring the same evidence-first posture to
infrastructure work.

**How serious is that verification? Serious enough to replace your CI gate.**
`dotbabel local-attest` runs your GitHub Actions matrix on your machine and,
on a clean pass, posts a SHA-pinned attestation that makes the remote
workflows skip themselves for that commit — one repo cut ~27 minutes of runner
time per push to zero. It is deliberately hard to fool: pinned to the exact
head SHA so the next push invalidates it, owner-authored comments only, a
refusal to attest when any leg was skipped or never launched, an audit log
that records failures as well as passes, and toolchain pins that fail the run
closed when your local Node or Go differs from CI's. That is the standard the
rest of the toolkit is built to.

It also runs everywhere you work: one rule floor, fanned out to Claude Code,
Codex, Gemini CLI, and Copilot CLI, with drift detection so the copies cannot
silently disagree.

**Who is this for?**

| I am…            | I want…                                                                          | Start here                                              |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Agent user**   | Skills that make Claude ground, verify, and cite its work                        | [Install as a plugin](#install-as-a-claude-code-plugin) |
| **Dotfile user** | The toolkit — skills, commands, and CLAUDE.md in every Claude session            | [Clone & bootstrap](#clone--bootstrap)                  |
| **CI payer**     | To stop re-running checks I already verified locally                             | [Local attestation](#local-attestation)                 |
| **Consumer**     | The CLI in my repo — bootstrap, doctor, drift detection, optional spec-gov gates | [Install the CLI](#install-the-cli)                     |
| **Library user** | Node API in my own tooling                                                       | [docs/api-reference.md](./docs/api-reference.md)        |
| **Contributor**  | Dev workflow, local gates                                                        | [CONTRIBUTING.md](./CONTRIBUTING.md)                    |

---

## TL;DR — pick your path

| What you want                                                                | How                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skills & subagents inside Claude Code, no clone                              | **[Install as a plugin](#install-as-a-claude-code-plugin)** — two slash commands   |
| Skills & commands library wired into `~/.claude/`                            | **[Clone & bootstrap](#clone--bootstrap)** — 30 seconds, no npm required           |
| Skip remote CI for commits you verified locally                              | **[Local attestation](#local-attestation)** — `npx dotbabel-local-attest --init`   |
| Governance CLI for your own repos (bootstrap + doctor + optional spec gates) | **[Install the CLI](#install-the-cli)** — see install section (Node ≥ 20 required) |

All four paths are independent. You can use one, some, or all of them.

---

## Local attestation

Verification you can substitute for the remote run. `local-attest` needs one
file: a matrix of the checks CI runs. `--init` drafts it from your existing
workflows, so adoption is a command rather than an afternoon:

```bash
npx dotbabel-local-attest --init
```

It reads `.github/workflows/*.yml`, turns every `run:` step in a
pull-request-triggered job into a leg, groups legs into one lane per job (lanes
run concurrently, legs within a lane run in order), mirrors any `paths:` filter
as a `when.changedPaths` rule, and copies `setup-node` / `setup-go` versions
into toolchain pins. Anything it cannot translate — a marketplace action, a
service container, a job-level `if:` — becomes a `TODO:` comment inside the
generated file rather than a silent omission.

**The draft is a starting point, not a gate.** Read it against your workflows
before you attest anything: a green attestation switches remote CI off, so a
check missing from the matrix is enforced nowhere. Then:

```bash
npx dotbabel-local-attest --dry-run   # run the matrix, print the comment, post nothing
npx dotbabel-local-attest             # run it, post the attestation, push
```

Wire the gate into a workflow by skipping when a trusted attestation matches
the head SHA. The full contract — comment format, trust model, audit log, and
the branch-protection caveat — is in
[`skills/local-attest/references/operator-guide.md`](./skills/local-attest/references/operator-guide.md);
the config schema is in
[`skills/local-attest/references/config.md`](./skills/local-attest/references/config.md).

---

## Install as a Claude Code plugin

The fastest path if you just want the skills and subagents inside Claude Code —
no clone, no npm:

```
/plugin marketplace add kaiohenricunha/dotbabel
/plugin install dotbabel@dotbabel
```

That installs the skills library and the specialist subagents. The
`local-attest` CLI is a separate install (`npx dotbabel-local-attest`, above),
because it runs your test suite and pushes commits — that belongs behind an
explicit install, not a plugin that arrives with everything else.

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

### User-scope rule-floor overlay (`~/.config/dotbabel/local-rules.md`)

`dotbabel bootstrap` (npm CLI, 2.7.0+) generates `~/.claude/CLAUDE.md` as a
real file containing the canonical dotbabel rule floor followed by a
marker-delimited overlay block. To layer your own personal rules on top
without forking dotbabel's source, drop them into
`~/.config/dotbabel/local-rules.md`:

```bash
mkdir -p ~/.config/dotbabel
cat > ~/.config/dotbabel/local-rules.md <<'EOF'
## My personal rules

- Default to drafts when opening PRs.
- Always link the Linear ticket in the PR body.
EOF
dotbabel bootstrap   # regenerates ~/.claude/CLAUDE.md with your overlay merged in
```

The overlay sits AFTER the canonical content (Claude Code's top-to-bottom
read order means your rules trump dotbabel defaults). Future `dotbabel
bootstrap` and `dotbabel sync` runs preserve the overlay, regenerating the
merged file on every invocation. Direct edits to `~/.claude/CLAUDE.md` are
backed up to `~/.claude/CLAUDE.md.bak-<timestamp>` before regen — always
edit `local-rules.md`, not the generated file.

The shell-only `./bootstrap.sh` quickstart still uses the legacy symlink
shape and does not support overlays. Install the npm package for overlay
support.

### Project-scope sync (cross-CLI per-repo wiring)

`dotbabel bootstrap` covers your **user scope** (`~/.claude/`, `~/.codex/`,
`~/.gemini/`). For **per-repo** artifacts — a project's own `CLAUDE.md`,
`.claude/commands/*.md`, and `.claude/skills/*` — use `project-sync` to fan
them out to Codex (`.codex/skills/`), Gemini (`.gemini/skills/`), and Copilot
(`.github/prompts/*.prompt.md` + `.github/instructions/*.instructions.md`):

```bash
cd ~/projects/my-app
dotbabel project-init                 # one-time: writes .dotbabel.json and a starter CLAUDE.md
dotbabel project-sync --dry-run       # preview planned actions
dotbabel project-sync                 # symlink everything in place
dotbabel check-project-sync           # CI-safe drift check (read-only)
dotbabel check-project-sync --all     # ...including CLIs you have not installed
```

The fan-out uses symlinks — your `.claude/` tree stays the single source of
truth. A `.dotbabel.json` is optional; without one, project-sync uses
sensible defaults and treats the entire `CLAUDE.md` as the project rule
floor (or the slice between `<!-- dotbabel:rule-floor:begin -->` /
`<!-- dotbabel:rule-floor:end -->` markers when present).

`gate_on_cli_presence` (default `true`) skips a CLI's symlink fan-out when its
binary is absent from `PATH`. `check-project-sync` honors the same setting, so
a machine without `gemini` installed does not report the un-synced Gemini tree
as drift; pass `--all` to either command to ignore the gate for one run.
Instruction files (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`)
are always written, never gated.

`fan_out_layout` (default `per-cli`) controls whether Codex and Gemini get
their own trees. Both read `<dir>/SKILL.md`, so `shared` writes one canonical
tree and points both at it, halving the entries git has to track:

```text
per-cli                          shared
.codex/skills/<name>/SKILL.md    .cli/skills/<name>/SKILL.md
.gemini/skills/<name>/SKILL.md   .codex/skills  -> ../.cli/skills
                                 .gemini/skills -> ../.cli/skills
```

Switching an existing repo to `shared` backs the old trees up to
`.codex/skills.bak-<timestamp>` before replacing them, so nothing is lost —
delete the backups once you are satisfied. Copilot keeps its own
`.github/prompts/` and `.github/instructions/` shapes either way. If a CLI
turns out not to follow the redirect, set `fan_out_layout` back to `per-cli`.

Point your editor at the config schema for autocomplete and validation:

```json
{
  "$schema": "https://dotbabel.dev/schemas/dotbabel.config.schema.json",
  "fan_out": ["codex", "gemini", "copilot"],
  "fan_out_layout": "per-cli",
  "gate_on_cli_presence": true
}
```

An unknown name in `fan_out` fails with `CONFIG_UNKNOWN_CLI` rather than being
skipped, so a typo cannot silently cost you a CLI's wiring; an unknown
`fan_out_layout` fails with `CONFIG_UNKNOWN_LAYOUT`.

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
