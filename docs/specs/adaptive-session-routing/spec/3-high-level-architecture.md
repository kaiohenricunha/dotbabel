# §3 — High-Level Architecture

- **ARCH-1:** Project configuration → activation gate → classifier → semantic demand → shared Model Intelligence resolver → runtime adapter → one main-session turn.
- **ARCH-2:** Classification, resolution and application are independently testable. The resolver performs no I/O or task classification.
- **ARCH-3:** Model capability and reasoning intensity remain independent axes. Native effort values come from runtime evidence, never a universal provider enum.
- **ARCH-4:** Absent project opt-in disables automatic behavior. Engine and routing use independent flags. Global installation never activates a repository.
- **ARCH-5:** Runtime support has `supported`, `unsupported` and `unverified` states with evidence, runtime version and mechanism. Discovery, artifact binding, invocation, turn override and effective observation remain separate.
- **ARCH-6:** One project's activation and policy never enter another project's shared cache. Shared public capability evidence excludes prompts, credentials and project policy.

The runtime keeps conversation and approval state. Routing keeps only bounded session-local decision context needed for manual provenance and hysteresis. Durable diagnostic data excludes original prompts by default.
