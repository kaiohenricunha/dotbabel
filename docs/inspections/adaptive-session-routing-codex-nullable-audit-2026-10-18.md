# Codex nullable override audit — 2026-10-18

## Evidence and candidates

Installed Codex 0.163.0 generated schema `v2/TurnStartParams.json` permits string or null for model and a reasoning effort or null for effort. Null means no explicit per-turn override. A valid native null must remain unchanged on a preserved route.

Candidate A is invalid native input. Against: the installed schema explicitly accepts null on both axes. The manual-source capture already treats only a string as explicit. Candidate B is misuse of the shared opaque-string validator. For: at reviewed source 4210632, `plugins/dotbabel/src/adaptive-session-routing/codex.mjs:64` calls checkOpaqueValue for any defined original override, including null. That validator deliberately throws on non-strings (`domain/index.mjs:147`). The proposed-change validation similarly calls it for numeric/null strategy values. Six new regressions fail: three nullable fallback combinations, independent nullable model/manual effort, and two malformed strategy values. Fifty router tests pass. Log: `/tmp/ar-503-nullable-red.log`.

## Correction

The autonomous assignment authorizes choosing B. Narrow a value to string before calling the existing shared validator. Requested-axis diagnostics omit null while forwarding it unchanged on a preserved route. An inherited null does not become a manual pin. Invalid strategy values diagnose invalid_routing_decision and forward the original request once, rather than escaping as an exception. Preserve all explicit string selections, floors, approvals, sandbox parameters and the uncertain-write barrier. The shared validator and native RPC contract remain unchanged.
