# Does a Claude Mods `turn.step` effort override change the request?

Date: 2026-10-23. Claude Code 2.1.309. Owner-approved spend: about USD 3; actual USD 0.85.

## Question

The Claude MAIN route writes the routed effort into `turn.step`'s `effort` field
(`plugins/dotbabel/src/adaptive-session-routing/claude-mod.mjs:118`). Earlier live turns could not tell
whether that override applies. `classic.Stop` reports `effort.level`, which the hooks reference
defines as "the effort level in effect when the hook runs", and it followed the user's
`effortLevel` setting (`medium` on 2.1.304, `xhigh` on 2.1.307), never the routed `low`.

Two explanations were possible:

1. The per-request override is ignored, and the request runs at the session or model default.
2. The override applies, and `classic.Stop` reports only the session setting.

## Method

`experiments/adaptive-session-routing-claude/effort-probe.mjs` runs one ordinary reasoning prompt
twelve times, alternating `low` and `high`. The prompt asks for the number of domino tilings of a
2x12 board. A private plugin rewrites only `turn.step`'s `effort`. The model is pinned to `haiku`.
The session setting, the prompt, the tools (none) and the working directory stay the same. The plugin
also logs the native request's own `effort` before the rewrite. The measure is
`modelUsage.thinkingTokens`. Raw rows: `experiments/adaptive-session-routing-claude/effort-probe-2026-10-23.json`.

## Result

| Override | n   | Thinking tokens              | Median | Answer          |
| -------- | --- | ---------------------------- | ------ | --------------- |
| `high`   | 6   | 120, 134, 159, 159, 197, 207 | 159    | 233 in all runs |
| `low`    | 6   | 38, 80, 95, 130, 142, 147    | 112.5  | 233 in all runs |

Exact Mann-Whitney test over all 924 splits: U(high) = 31 of 36, one-sided p = 0.018, two-sided
p = 0.037. In every run the native request's own effort before the rewrite was `medium`, the native
default for Haiku 5.5. `usage.model` was `claude-haiku-5-5` in every run.

## Conclusion

The evidence supports explanation 2: the `turn.step` effort override changes the request, and
`classic.Stop` reports the session setting, not the per-request effort. This is moderate evidence, not
proof. The test has one prompt, one model and six runs per group, and thinking-token counts are a proxy
for effort. The Claude MAIN route should keep reporting the observed effort as `unknown` or as the
`classic.Stop` value, because no native field reports the per-request effort. The claim "effort routing
applies" may be made only with this qualification.

## Side observations

- The native request effort was `medium`, while the user's `effortLevel` setting was `xhigh`. So the
  session setting does not reach a `-p` request's `turn.step` effort on this build.
- Claude Code updated itself to 2.1.309 during this work. The MAIN launcher accepts only measured
  releases (2.1.302, 2.1.304, 2.1.307), so it reports `routing_unverified` until 2.1.309 passes the
  acceptance steps in `experiments/adaptive-session-routing-claude/README.md`.
