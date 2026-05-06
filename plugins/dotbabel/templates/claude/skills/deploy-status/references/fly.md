# Fly.io Deploy Status

## Discovery

Auto-discovery reads `fly.toml` from the consuming project root and extracts the
top-level `app = "..."` value.

## Auth

Use existing Fly CLI auth:

```bash
fly auth whoami
```

The helper tries `flyctl` first and falls back to `fly`.

## Production Release Lookup

The helper uses:

```bash
fly releases --image --app <app> --json
```

If the local CLI does not support `--image`, it falls back to:

```bash
fly releases --app <app> --json
```

The git SHA is extracted from release metadata when present. Some Fly deploy
flows do not preserve a git SHA in release JSON or image tags; in that case the
target reports `unknown SHA` and exits `2` instead of guessing.

## Failure Modes

- CLI not installed or not authenticated: target error, status exit `2`.
- No successful releases: target error, status exit `2`.
- Release metadata has no git SHA: target error, status exit `2`.
