# @kaiohenricunha/harness

Portable SDD + harness engineering kit. Dual-purpose:
- **As a Claude Code plugin:** ships slash commands (`/init-harness`), skills, hooks, and templates.
- **As an npm package:** ships CLI validators (`harness-validate-skills`, `harness-check-spec-coverage`, `harness-validate-specs`, `harness-check-instruction-drift`) for CI use.

## Install

```bash
npm install -D git+https://github.com/kaiohenricunha/dotclaude.git#main:plugins/harness
```

For the Claude plugin side, install via `/plugin install git+https://github.com/kaiohenricunha/dotclaude.git#main:plugins/harness`.

## Contract

Your repo must follow these conventions:

- `docs/repo-facts.json` — canonical source of truth (team count, protected paths, etc.)
- `docs/specs/<slug>/spec.json` — spec metadata (id, status, owners, linked_paths, acceptance_commands, depends_on_specs, active_prs)
- `.claude/skills-manifest.json` — SHA256 checksummed inventory of `.claude/commands/*.md` and `.claude/skills/*/SKILL.md`
- `.github/workflows/validate-skills.yml` — weekly CI plus per-PR check

## CLI

```bash
harness-validate-skills [--repo-root <path>] [--update]
harness-check-spec-coverage [--repo-root <path>]    # reads PR_BODY, GITHUB_BASE_REF, GITHUB_ACTOR from env
harness-validate-specs [--repo-root <path>]
harness-check-instruction-drift [--repo-root <path>]
```

All bins default to `git rev-parse --show-toplevel` when no `--repo-root` is passed.

## API

```javascript
import {
  createHarnessContext,
  validateManifest,
  EXIT_CODES,
} from "@kaiohenricunha/harness";

const ctx = createHarnessContext({ repoRoot: "/path/to/repo" });
const result = validateManifest(ctx);
```

Every export comes from the single barrel. Deep imports are not a supported contract.
