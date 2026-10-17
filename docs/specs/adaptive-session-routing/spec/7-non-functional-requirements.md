# §7 — Non-Functional Requirements

- **PERF-1:** Local classification and routing decision p95 is at most 25 ms over 1,000 warmed calls on the committed fixture set, excluding runtime execution and discovery. Failure blocks the performance acceptance check.
- **REL-1:** Disabled projects execute zero automatic discovery, classification, runtime calls or configuration writes. A disabled-path spy/integration test fails on any call.
- **REL-2:** Each original submission and its attachments reach the harness exactly once. Uncertain submission delivery never triggers an automatic replay.
- **REL-3:** Classification, stale evidence, entitlement, unsupported effort and application failures preserve the existing configuration or stop before execution with an explicit diagnostic; no false satisfaction is reported.
- **REL-4:** Main-session routing changes zero subagent compute declarations. All runtime adapters preserve native approval and sandbox semantics.
- **SEC-1:** The default classifier sends zero prompt/repository bytes to an additional provider. No classifier gets credentials or full repository contents by default.
- **SEC-2:** Configuration changes remain inside the selected project. Symlinks and malformed configuration fail before mutation. A serialized read-modify-write preserves unrelated fields and files.
- **OPS-1:** Status and real-turn evidence distinguish proposed, requested and effective configurations. Unsupported and unverified mechanisms cannot appear active.
- **OPS-2:** Every failure exposed by the CLI includes a stable diagnostic code, with no credentials or raw malformed configuration contents.
