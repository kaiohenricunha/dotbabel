# Vercel Deploy Status

## Discovery

Auto-discovery reads `.vercel/project.json` from the consuming project root.
Expected fields:

- `projectName` or `projectId` identifies the Vercel project.
- `orgId` is preserved as metadata. The CLI scope flag is only used when config
  provides `scope` or a non-`team_` team value.

## Auth

Use existing Vercel CLI auth:

```bash
vercel whoami --cwd <project-root>
```

Do not ask for or print tokens.

## Production Release Lookup

The helper uses:

```bash
vercel list <project> --environment production --status READY --format json --yes --cwd <project-root>
vercel inspect <deployment-id-or-url> --format json --cwd <project-root>
```

The git SHA is extracted from common Vercel metadata fields such as
`meta.githubCommitSha`, `gitSource.sha`, or other commit/SHA-bearing metadata.

## Failure Modes

- CLI not installed or not authenticated: target error, status exit `2`.
- No READY production deployments: target error, status exit `2`.
- Deployment exists but no git SHA is exposed: drift is unknown, status exit `2`.
