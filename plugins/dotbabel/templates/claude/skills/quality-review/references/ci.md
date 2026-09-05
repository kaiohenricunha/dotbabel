# Quality CI reference

Use the `pr` profile for pull requests. Fetch enough Git history to resolve the merge base.

```bash
dotbabel quality check \
  --profile pr \
  --base "$QUALITY_BASE_REF" \
  --allow-project-commands \
  --json
```

Install the project's normal dependencies before this command. Dotbabel never installs a missing analyzer.
Store the JSON result as an artifact. Fail CI for exit code `1` or `2`.

Use `deep` for a scheduled or manual audit. Keep mutation and Go race checks out of the normal pull-request profile.

`local-attest` can include the quality command as an optional hard leg. The two workflows remain independent.
