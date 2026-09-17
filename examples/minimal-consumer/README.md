# minimal-consumer

Committed output of `npx dotbabel-init --project-name minimal-consumer --project-type node`.
This example exists so `dogfood.yml` (PR 7) can run every validator against a
post-scaffold tree and catch breakage before consumers ever npm-install the
package.

**Do not hand-edit.** If the scaffolder output changes, regenerate:

```bash
# NOTE: this README is hand-maintained and is NOT scaffolder output, so the
# rm -rf below deletes it. Restore it afterwards:
#   git checkout HEAD -- examples/minimal-consumer/README.md
rm -rf examples/minimal-consumer
mkdir examples/minimal-consumer
cd examples/minimal-consumer
git init
node ../../plugins/dotbabel/bin/dotbabel-init.mjs --project-name minimal-consumer --project-type node
rm -rf .git
```

The tree mirrors what `scaffoldHarness` writes for a fresh consumer repo:

- `.claude/` — skills-manifest, headless settings, destructive-git hook
- `docs/` — repo-facts, spec README
- `.github/workflows/` — ai-review, detect-drift, quality, test, validate-skills
- `githooks/pre-commit` — auto-refresh checksums when a skill file changes
- `githooks/pre-push` — the `fast` quality profile before a push (opt in with
  `git config core.hooksPath githooks`)
