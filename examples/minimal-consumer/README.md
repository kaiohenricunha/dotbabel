# minimal-consumer

Committed output of `npx dotclaude-init --project-name minimal-consumer --project-type node`.
This example exists so `dogfood.yml` (PR 7) can run every validator against a
post-scaffold tree and catch breakage before consumers ever npm-install the
package.

**Do not hand-edit.** If the scaffolder output changes, regenerate:

```bash
rm -rf examples/minimal-consumer
mkdir examples/minimal-consumer
cd examples/minimal-consumer
git init
node ../../plugins/dotclaude/bin/dotclaude-init.mjs --project-name minimal-consumer --project-type node
rm -rf .git
```

The tree mirrors what `scaffoldHarness` writes for a fresh consumer repo:

- `.claude/` — skills-manifest, headless settings, destructive-git hook
- `docs/` — repo-facts, spec README
- `.github/workflows/` — ai-review, detect-drift, validate-skills
- `githooks/pre-commit` — auto-refresh checksums when a skill file changes
