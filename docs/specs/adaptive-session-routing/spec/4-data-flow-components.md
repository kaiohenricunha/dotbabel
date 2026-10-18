# §4 — Data Flow / Components

## Classification

**KD-1:** Start with deterministic, local contextual classification. Evaluate lexical/task heuristics against fixtures before enabling them. They are inexpensive and private but can misread negation, quoted instructions, unfamiliar domains and implicit requirements. Low confidence preserves current configuration rather than pretending certainty.

Context may include an explicit specification, component count, uncertainty, risk, consequences, verification burden and recent failed attempts. It is bounded supplied context; a classifier does not scan the full repository per prompt. Its strategy interface permits future replacement. Model-assisted classification is a separate explicit privacy opt-in and is not the default.

## Resolution and application

**KD-2:** The classifier emits semantic workload demand and separate effort intent. The shared resolver composes that demand with project/user policy and verified capabilities. No adapter selects models independently.

**KD-3:** Explicit manual model and effort selections win independently. Unknown provenance is conservative. Floors still apply: a below-floor manual choice is reported as unsatisfied, never as compliant. A turn retains its decision throughout tool execution; no mid-operation switch or replay is permitted.

**KD-4:** Hysteresis may retain a currently satisfying model when confidence or expected benefit does not justify a change. It never retains a known violation. Record why a change was retained or applied.

**KD-5:** Claude main-session handling filters subagent events. Codex routes before `turn/start`, using the same thread ID and original input array. A submission with an uncertain transport outcome is not automatically retried.
