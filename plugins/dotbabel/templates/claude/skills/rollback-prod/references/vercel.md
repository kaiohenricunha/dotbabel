# Vercel Rollback

## Release Pair

The rollback helper fetches the two latest READY production deployments with the
same Vercel status calls used by `/deploy-status`.

## Native Rollback

After the operator types `ROLLBACK PROD`, the helper rolls back to the previous
deployment:

```bash
vercel rollback <previous-deployment-id-or-url> --yes --timeout 5m --cwd <project-root>
```

The helper's typed confirmation is mandatory. The Vercel `--yes` flag is only
used after that gate to avoid a second provider prompt.

## Failure Handling

- If fewer than two READY production deployments exist, no rollback action runs.
- If Vercel rollback fails, the helper reports that target as failed and does not
  attempt to undo other successful target rollbacks.
