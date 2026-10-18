# Codex routing boundary checkpoint

The original full initiative remains open. The scoped autonomy grant starts 2026-10-18 03:23:34 UTC and expires 15:23:34 UTC; pushes and merges are authorized, Full access is active. Activation #496, resolver #499 and classifier #501 are merged. Core AR-3 remains in its own worktree and PR-quality verification. No global native configuration, hook, trust, credential or grant changes implement this routing.

This worktree starts from origin/main a05011b and merges core 90ef5bd. Native codex.mjs and codex-rpc.mjs have 26 passing submission/protocol tests, with missing-module and behavioral red baselines in /tmp/ar-codex-*.log. A copied parent route.mjs adds the verified-cold-turn condition from core d5dccfc; integrate the complete parent by normal merge before publication so that dependency is not duplicated in this PR.

The real controlled native run succeeds in /tmp/ar-codex-real-turn-proof-5.json and experiments/adaptive-session-routing-codex/native-proof-2026-10-18.json. It applies a new model/low effort before the first prompt and high effort before the next prompt on one retained native thread. Both complete, native observations match, and input hashes prove one submission each. Early non-Git and incorrectly configured probes fail and are documented separately. No live acceptance criterion is promoted yet.

Next: harden boundaries, complete mutation and quality, version-aware capability metadata, a runnable managed client with native approval delegation and truthful status/setup, full review and exact-head CI. Implement Claude mods in a separate unit. Original projections, snapshots, build integration, migrations, recommendations, observation, remaining adapters and final full audit remain required.
