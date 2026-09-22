---
id: security-audit
name: security-audit
type: skill
version: 1.0.0
domain: [devex, security]
platform: [none]
task: [review, diagnostics]
maturity: draft
description: >
  Whole-repository security audit with independent verification of every finding,
  vendored from cloudflare/security-audit-skill. Guidance by default; runs the full
  six-phase audit (parallel hunters, verifiers that did not hunt, coverage ledger,
  schema-validated findings.json) only on an explicit audit or pen-test request.
  Triggers on: "security audit", "audit this codebase", "pen test the code",
  "full security review", "end-to-end security review", "security audit report".
argument-hint: "[scope path | subsystem | <base>..<head>] [--profile quick|standard|deep]"
model: opus
---

# Security Audit

This skill wraps the upstream [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill).
The upstream workflow is authoritative. This file only maps it onto dotbabel hosts.

## Read the upstream skill first

1. Read `references/upstream/UPSTREAM-SKILL.md` in full, then follow it.
2. Load the other files in `references/upstream/` only when `UPSTREAM-SKILL.md` or a phase document tells you to.

The upstream copy is pinned and unchanged. `references/UPSTREAM.json` records the commit.
Do not edit files in `references/upstream/`. A maintainer updates them with `scripts/sync-security-audit.mjs`.

## Path mapping

The upstream docs assume that the upstream `SKILL.md` sits at the skill root. In this layout:

- **Skill directory** and `<skill-dir>` mean the absolute path of `references/upstream/` in this skill, not the folder that contains this file.
- A bare `SKILL.md` in the upstream docs means `references/upstream/UPSTREAM-SKILL.md`.
- The validators run as `node <skill-dir>/validate-findings.cjs <output-dir>/findings.json` and `node <skill-dir>/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json`.

## Host mapping

The upstream roles are agent-neutral (`UPSTREAM-SKILL.md`, "Platform terminology").

| Upstream role    | Claude Code                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parent           | The main session. It is the only writer of shared run files.                                                                                                             |
| Task tool        | The `Agent` tool.                                                                                                                                                        |
| `research` agent | `subagent_type: general-purpose`, with a prompt that keeps it read-only. Do not use `Explore`: it reads file excerpts, and the upstream verifiers need whole-file reads. |
| `general` agent  | `subagent_type: general-purpose`.                                                                                                                                        |

On Codex, Gemini, Copilot, or another host, use the host's sub-agent mechanism only when each agent gets its own context.

- If the host has no isolated parallel sub-agents, do not run full audit mode. The upstream guarantee is that the agent that checks a finding never found it. Say that this host cannot give that guarantee, and offer guidance mode.
- If the host cannot enforce every OS sandbox control in "Universal execution safety", do not execute target code. Keep such leads as `needs_validation`, as the upstream rules require.

## When to use this skill, and when to use `security-review`

- Use `security-review` for a fast checklist review of one diff (staged changes, a PR, or a path). `pre-pr` runs it.
- Use this skill for a whole-repository or subsystem audit, a pen-test-style source review, or report artifacts. A standard run takes a long time and launches many agents. Tell the user the profile and any agent budget before you start (`UPSTREAM-SKILL.md`, "Run profiles and scope" and "Cost budget").

## Optional: feed confirmed findings to `dotbabel quality`

`scripts/findings-to-sarif.mjs` converts a finished run into SARIF 2.1.0:

```bash
node <this-skill>/scripts/findings-to-sarif.mjs --run-dir <output-dir> --out .dotbabel/security-audit.sarif
```

- It refuses a run whose `run_status` is not `complete`, and a `findings.json` that `validate-findings.cjs` rejects (exit 2).
- It emits only `confirmed` records. `critical` and `high` map to `security-severity` 9.5 and 8.0, so `dotbabel quality` reports them as `security.high_confidence`.

To make the `pr` and `deep` quality profiles read the last run, write the run to an output directory that git ignores (the upstream rules allow this only when you select it and git ignores it), then declare the converter as the security tool in `.dotbabel.json`:

```json
{
  "quality": {
    "components": [
      {
        "root": ".",
        "languages": ["javascript"],
        "tools": {
          "security": {
            "argv": [
              "node",
              ".claude/skills/security-audit/scripts/findings-to-sarif.mjs",
              "--run-dir",
              ".security-audit/run-1",
              "--out",
              ".dotbabel/security-audit.sarif"
            ],
            "report": { "format": "sarif", "path": ".dotbabel/security-audit.sarif" }
          }
        }
      }
    ]
  }
}
```

Change `languages` and the run directory to match the repository. The script path above is the `dotbabel init` install location. A `bootstrap.sh` install uses `~/.claude/skills/security-audit/` instead.

## Attribution

The upstream skill is Copyright Cloudflare, Inc. and ships under the MIT License in `references/upstream/LICENSE`.
