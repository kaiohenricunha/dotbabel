# §8 — Risks and Alternatives

| Risk                                                            | Mitigation                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Heuristics miss implicit task demands                           | Preserve uncertainty; use bounded context and fixture evaluation; allow strategy replacement.        |
| Runtime APIs change                                             | Pin recorded build/schema evidence, capability-gate adapters and keep fixture plus real smoke tests. |
| Native stock CLI has no supported interception                  | State the limitation; offer an explicitly managed supported execution mode.                          |
| Manual-selection provenance is unavailable                      | Preserve ambiguous axes; do not infer consent from runtime defaults.                                 |
| Switching loses cache benefit or changes conversation semantics | Retain the thread, hold the decision per turn and test hysteresis.                                   |
| Provider usage limits block real proof                          | Record the exact blocked check; continue local work without claiming runtime completion.             |

Reject a separate model registry/resolver, always-paid classifier, instruction-only model switching, global settings edits on project change, fresh conversation per prompt, automatic replay after uncertain delivery and tests that count skipped runtime checks as passes.
