# §6 — Implementation Plan

## Phases

1. **AR-1 activation:** tests first for absent flags, independent flags, concurrent enabled/disabled projects, unrelated configuration preservation and malformed config. Implement shared activation boundary and CLI; run it on isolated project directories.
2. **AR-2 classifier:** tests first on representative engineering fixtures, context/failure effects, uncertainty, bounded input, quoted/negated misleading keywords and independent axes. Compare simple lexical, contextual and optional model-assisted approaches. Implement local default; report fixture agreement and limitations, never model-ranking accuracy.
3. **AR-3 routing core:** tests first for policy floors, pins, manual axis independence, unsupported effort, stale evidence, uncertainty fallback, hysteresis and unchanged subagents. Integrate the completed P-10/P-11 resolver.
4. **AR-4 Claude:** research installed types and official docs, then tests first for main-only events, exactly-once forwarding, fixed turn decisions and truthful applied/effective state. Validate an isolated mod and real session; publish precise supported/experimental/unverified limits.
5. **AR-5 Codex:** research installed App Server schema, then tests first for a retained thread, two configurations, exact input/attachments, override persistence, failures and approvals. Implement a managed client when stock CLI lacks interception; prove real effective model/effort in an isolated thread.
6. **AR-6 acceptance and documentation:** activate only implemented criteria, run project-sync/bootstrap/handoff/governance/generation regressions, publish setup/disable/troubleshooting/rollback and a compatibility matrix.

AR-2 can start before every artifact migration, but AR-3 depends on P-10/P-11. Keep runtime routing out of unrelated artifact/build PRs. Each unit uses TDD, runs the feature, records commands and output, reviews once, and follows the authorized PR workflow.

## Verification matrix

Unit/property: deterministic classification and resolver composition, floors, manual precedence and exactly-once state machines. Contract/golden: CLI JSON, runtime RPCs, capability evidence and fixture labels. Integration: concurrent projects, filesystem configuration, subprocess transport and retained conversations. Mutation: classifier and routing decisions using a runner proven to execute selected tests. Performance: bounded warm per-prompt overhead. Real runtime: separate Claude/Codex controlled smoke scenarios; mocked configuration objects cannot close them. Statistical: report classification fixture agreement, sample count and limitations; no probabilistic default or universal model ranking. Post-release: check effective integration and configuration on installed package; mark pending until actually run.

## Rollback

Disable routing first (`models disable --routing`), preserving engine diagnostics and agent settings. Disable the engine separately (`models disable`). Remove only the explicitly installed integration through its documented runtime mechanism; never delete user-owned files. Document restart/reload requirements and persistent Codex turn defaults.
