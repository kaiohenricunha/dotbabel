Scaffold the harness + SDD skeleton in the current repo and install the `@dotbabel/dotbabel` plugin.

Trigger: direct invocation via `/init-harness <project-name>`. Also triggered when the user says "scaffold the harness in this repo" / "set up spec-driven development here" / "init claude config for this project".

Arguments: `$ARGUMENTS` — optional project name (defaults to the basename of `pwd`).

## Steps

1. **Confirm repo state.** Run `git rev-parse --is-inside-work-tree`; abort if not inside a git repo. Run `git status --short` and surface any uncommitted changes — ask the user to stash or commit first.

2. **Detect project type.** Look for `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `Gemfile`. Record findings for use in template substitution.

3. **Copy the template tree** from the plugin. Source: the plugin's `templates/` directory (resolve via `require.resolve('@dotbabel/dotbabel/package.json')` → package root → `templates/`). Target: the repo root.

4. **Substitute placeholders.** Every template file may contain `{{project_name}}`, `{{project_type}}`, and `{{today}}`. Replace them.

5. **Compute initial `skills-manifest.json` checksums.** Run `npx dotbabel-validate-skills --update` after copying templates so the manifest has current checksums.

6. **Install the plugin.** Add `@dotbabel/dotbabel` as a devDependency if `package.json` exists; otherwise print a note that the CLI bins must be installed via `npx @dotbabel/dotbabel@latest` or globally.

7. **Verify.** Run `npx dotbabel-validate-skills`, `npx dotbabel-validate-specs`, `npx dotbabel-check-instruction-drift`. All must pass.

8. **Report.** Show the user what was created (files list), how to run the verification suite locally (`npm run verify:repo:harness` if package.json, else `npx dotbabel-*`), and a link to the docs in the plugin README.

## Rules

- Never overwrite an existing file without explicit user approval. If a template destination exists, diff and ask.
- Never commit on the user's behalf — leave the scaffold as a staged-ready working tree.
- If any verify step fails, report the failure and stop. Do not try to auto-fix.
- If the repo already has `.claude/skills-manifest.json` or `docs/specs/`, the repo is already partially initialized — refuse to run and suggest `/audit` instead.
