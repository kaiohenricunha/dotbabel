# Fly.io Rollback

## Release Pair

The rollback helper fetches successful Fly releases with image metadata:

```bash
fly releases --image --app <app> --json
```

It needs the current and previous release plus the previous release image.

## Native Rollback

Fly's documented rollback path is redeploying the previous release image. After
the operator types `ROLLBACK PROD`, the helper runs:

```bash
fly deploy --app <app> --image <previous-image> --yes
```

If the local CLI is named `flyctl`, the helper uses `flyctl` with the same
arguments.

## Failure Handling

- If the release list does not expose an image for the previous release, no Fly
  rollback action runs.
- A Fly rollback may run the app's `release_command`. This skill does not roll
  back databases or undo migrations.
- If Fly rollback fails after another target succeeded, the helper reports the
  partial state and leaves follow-up action to the operator.

## See also

- `/flyctl` — ad-hoc fly ops (deploy, secrets, scale) when you don't need a full multi-target rollback.
- `/deploy-status` — read-only SHA reporting across all deploy targets.
