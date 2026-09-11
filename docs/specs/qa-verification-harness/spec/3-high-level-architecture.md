# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

The harness adds one question to every stage that dotbabel already governs: did the promised behavior run, and where is the proof? It adds no service. It extends five existing layers and adds one command family, `dotbabel criteria`.

| Layer            | Existing base                                                                 | What this spec adds                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec             | `spec.json`, `dotbabel-validate-specs`, the `spec` and `validate-spec` skills | Optional acceptance criteria with per-test confirmation and a planned or active status (KD-1, KD-3, KD-15)                                                                                |
| Pull request     | `review-pr`, `pr-conductor`, `pr-gates.mjs`, `dotbabel pr-stack`              | `dotbabel criteria verify`, append-only trusted evidence comments (KD-2), criteria reason codes, advisory test-quality judgment (KD-4), enforcement and assurance settings (KD-14, KD-16) |
| Quality          | `dotbabel quality`, language adapters, report parsers                         | Path-triggered tools and the `regression` capability (KD-5), active `critical_paths` (KD-6), mutation detection (KD-7), Python and Node test and coverage plans (KD-8)                    |
| Consumer surface | `dotbabel init` templates, hooks, `dotbabel doctor`                           | CI workflow templates (KD-10), a pre-push hook (KD-11), related tests at turn end (KD-12), an evidence guard hook (KD-16), warnings for removed keys (KD-9)                               |
| Post-deploy      | `deploy-status`, `release-conductor verify`, `rollback-prod`                  | Smoke checks and the `smoke-test` skill (KD-13)                                                                                                                                           |

```mermaid
flowchart LR
  subgraph SpecStage[Spec stage]
    SJ[spec.json acceptance_criteria] --> VS[dotbabel-validate-specs]
  end
  subgraph PRStage[Pull request stage]
    RP[review-pr last step] --> CV[dotbabel criteria verify]
    CV -->|argv through the quality runner| TR[repository test runner]
    TR -->|exit code, JUnit XML, output| CV
    CV -->|new SHA-pinned comment| GC[(PR comments)]
    MG[dotbabel pr-stack gate --gate merge] -->|reads with edit metadata| GC
    MG -->|reads specs at head, config at base| SJ
  end
  subgraph QualityLayer[Quality layer]
    QC[dotbabel quality check] -->|path triggers, critical paths| PT[project tools]
  end
  subgraph PostDeploy[Post-deploy]
    DS[deploy-ops.mjs status] --> SM[deploy-ops.mjs smoke]
    SM -->|HTTP GET and argv checks| DT[deployed targets]
  end
  SJ --> RP
  QC -->|verdict| MP[merge-pr step 5]
```

### Architecture Constraints

- **ARCH-1**: dotbabel stays a CLI and skill toolkit. This spec adds no service, daemon, or database.
- **ARCH-2**: Every command that the npm package executes for the harness runs through the quality runner (`plugins/dotbabel/src/quality/runner.mjs:22-94`), so trust, `shell: false`, the environment allowlist, output caps, timeouts, and redaction apply the same way everywhere. When several criteria share one command, the runner executes it once (`plugins/dotbabel/src/quality/runner.mjs:102-115`), and the criteria core applies that result to each of those criteria. The deploy helper is the one exception: scaffolded copies of it cannot import package source (the run-direct guard comment in `skills/deploy-status/scripts/deploy-ops.mjs`), so it carries equivalent guards of its own (KD-13).
- **ARCH-3**: Gate logic stays pure. All `gh` and `git` calls stay in the bins (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:10`), and `pr-gates.mjs` receives plain data.
- **ARCH-4**: `CONDUCTOR_PHASES` keeps its six phases (Q-3, `plugins/dotbabel/src/pr-gates.mjs:43`).
- **ARCH-5**: dotbabel never installs a test, coverage, or mutation tool (`docs/quality.md:5`, Q-4).
- **ARCH-6**: The criteria command and the merge gate parse `## Spec ID` with one shared parser that ignores fenced code, so they always agree on which specs a pull request links. Today the section extractor does not skip fences (`plugins/dotbabel/src/spec-harness-lib.mjs:333-341`), while the gate strips fences first (`plugins/dotbabel/src/pr-gates.mjs:256`).

## Data Stores

| Store                                          | Role                                                                                                  | Access Pattern                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/<id>/spec.json`                    | Acceptance criteria, their status, and acceptance commands                                            | Written by people and the `spec` skill. The merge gate reads it at the pull request head and at the base ref                      |
| `.dotbabel.json`, `quality` key                | Tool `paths`, `critical_paths`, mutation tools                                                        | Read on every quality run                                                                                                         |
| `.dotbabel.json`, `criteria` key               | Enforcement mode, trusted associations, pass-through variables, CI check requirement, default timeout | Read by `dotbabel criteria`. The merge gate reads it at the base ref                                                              |
| Pull request comments on GitHub                | Append-only evidence comments                                                                         | Created by `dotbabel criteria verify --post` and never edited. Older ones are minimized as outdated. The gate reads edit metadata |
| Pull request body on GitHub                    | `## Spec ID`, `## Test plan`, the test-plan deferral marker, and `## Criteria change rationale`       | Read by the merge gate and by `dotbabel criteria verify --pr`                                                                     |
| Check runs on GitHub                           | The `dotbabel criteria` CI check on the head SHA                                                      | Written by the `test.yml` template. Read by the merge gate when `require_ci_check` is true                                        |
| `.claude/deploy-targets.json`                  | Deploy targets and their smoke checks                                                                 | Read by `deploy-ops.mjs status` and `smoke`                                                                                       |
| User-scope trust allowlist                     | Trusted repository paths (`plugins/dotbabel/src/trust-allowlist.mjs:216`)                             | Read before any project command runs                                                                                              |
| `.dotbabel/` in the repository, ignored by Git | JUnit reports and evidence JSON from local runs                                                       | Written on each run and never committed. Each criterion's report is deleted before its run                                        |
| CI artifacts                                   | Quality and criteria JSON reports from the workflow templates                                         | Written by CI and read by reviewers                                                                                               |

## External APIs / Dependencies

| Service                                     | Purpose                                                                                                                       | Rate Limits / Constraints                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub REST and GraphQL APIs through `gh`   | Read pull requests and check runs, list comments with edit metadata, create comments, and minimize outdated evidence comments | 5,000 requests per hour for each authenticated user. A comment body holds at most 65,536 characters (DOC-18). Users with write access can edit any comment (DOC-22) |
| Test runners owned by the repository        | Run criterion tests                                                                                                           | Must print test names or write JUnit XML (DOC-15)                                                                                                                   |
| Coverage tools declared by the repository   | Coverage reports for quality plans                                                                                            | Detected, never installed (ARCH-5)                                                                                                                                  |
| Mutation tools configured by the repository | Mutation reports in the `deep` profile                                                                                        | Detected, never installed. They run in `deep` only (`docs/quality.md:199`)                                                                                          |
| Deployed targets                            | Smoke checks after a deploy                                                                                                   | Only HTTP GET checks retry, redirects stay on the same https origin, and each check and each run has a time limit (PERF-6, SEC-8)                                   |
| npm registry                                | Distribution and `release-conductor verify`                                                                                   | Unchanged                                                                                                                                                           |

## Deployment

- The harness ships in the `@dotbabel/dotbabel` npm package. `package.json` already ships `schemas/`, `skills/`, `plugins/dotbabel/bin/`, `plugins/dotbabel/src/`, and `plugins/dotbabel/templates/`.
- It runs in three places: an agent session in Claude Code, Codex, Gemini, or Copilot through the synced skills; a developer shell; and CI through the workflow templates.
- Skills reach consumers through `dotbabel init`, `bootstrap`, and `project-sync`. Templates regenerate with `npm run build-plugin`.
- Each phase in §6.1 releases as a semver minor version (§6.5, DOC-21).
