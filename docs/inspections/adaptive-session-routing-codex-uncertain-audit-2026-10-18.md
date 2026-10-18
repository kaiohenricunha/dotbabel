# Codex uncertain completion audit — 2026-10-18

## Candidate causes and evidence

A stale completion from a previously finished turn can release a newer write whose acknowledgement is lost. Candidate A is transport retry or deduplication eviction. Against: `plugins/dotbabel/src/adaptive-session-routing/codex.mjs:72` sends once, the catch records an uncertain sentinel, and the submission ledger retains the existing promise. Existing duplicate and uncertain-write tests confirm one native request per id.

Candidate B is uncorrelated completion handling. For: `codex.mjs:105` clears activeTurn when it equals any notification's turn id **or** the uncertain sentinel. Thus any valid completion in the owned thread, including an old duplicate, clears the uncertain barrier. The new regression completes turn-1, loses the next acknowledgement, delivers an old turn-1 completion, and observes a third native submission. It fails with accepted instead of blocked in `/tmp/ar-codex-uncertain-completion-red.log`.

## Decision and correction

Choose B. The autonomous task authorizes removing the wildcard uncertain-sentinel release. A known accepted turn still completes normally, including the early-completion race. An unknown write stays blocked because its completion cannot be correlated. The caller must inspect native state before explicitly creating another boundary; it must never replay the uncertain original submission automatically. This is a deliberate safe recovery limit, not a claim of native cancellation or failure. No permission or sandbox parameter changes.
