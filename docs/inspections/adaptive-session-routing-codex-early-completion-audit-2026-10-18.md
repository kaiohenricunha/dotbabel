# Codex early completion ordering audit — 2026-10-18

The reviewed baseline is bc311425073a72521ad0821ec03bec868de5d93b.

## Candidate causes

Candidate A is lost or missing native completion. Against: the local reproduction explicitly delivers the matching terminal event before acknowledgement; `codex.mjs:105` validates its method, thread, id and terminal status. The same event alone passes the existing early-completion test.

Candidate B is overwritten evidence in the consumer. For: `plugins/dotbabel/src/adaptive-session-routing/codex.mjs:106` stores one id, replacing the matching id when a stale completion arrives. Line 76 then marks the already completed acknowledged turn active. New tests deliver both orders: new then old fails with blocked instead of accepted, old then new passes. This independently confirms the architecture and security review findings. The red run has one failed and 45 passing router tests (`/tmp/ar-503-early-order-red.log`).

## Decision and correction

The autonomous assignment authorizes choosing B. Retain a set of at most 32 distinct early completion ids until acknowledgement correlation. An unrelated event cannot remove an already retained matching id. Repeated ids consume no new slot. If the bound is exhausted, report native_completion_buffer_full and retain existing evidence; missing correlation remains conservative. Clear the buffer between submissions. Never release an uncertain write from an uncorrelated completion. Add ordering, burst, deduplication and per-submission reset regressions; retain all prior uncertain-write tests.
