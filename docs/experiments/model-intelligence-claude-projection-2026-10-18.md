# Claude projection acceptance — 2026-10-18

Claude Code 2.1.302 loads the generated agent, command and skill in a credential-free scratch configuration. The Tier 2 test creates the actual runtime files, starts the installed CLI, reads system/init and stops at initialization. The event lists projection-example in agents, example-command in slash_commands, and example-skill in both slash_commands and skills. Generated frontmatter contains no private dotbabel mapping.

The probe records zero input/output tokens, zero API duration, an empty modelUsage object and zero cost. Its synthetic authentication failure counts one attempted turn in Claude's result envelope; that is not an executed inference turn. The test checks the available result counters instead of treating the envelope count as billed work. The isolated runner supplies no credential and uses the existing dead-port proxy boundary. It never runs against the user's real runtime configuration.

This proves native frontmatter loading. It does not prove an agent's effective model/effort during inference. The native fixture supplies explicit test capability facts; it does not claim account entitlement or model discovery. Main-session adaptive routing and its effective-configuration proof remain separate open work.

Run:

```bash
DOTBABEL_MODELS_INTEGRATION=1 npm test -- plugins/dotbabel/tests/integration/model-intelligence-claude-projection.integration.test.mjs
```

The normal suite skips this installed-runtime test unless explicitly enabled. A missing binary is also reported as skipped. The observed CLI version is asserted and included in test output. The public metadata references are [Claude subagents](https://code.claude.com/docs/en/sub-agents) and [Claude skills](https://code.claude.com/docs/en/skills); the local test is the acceptance evidence for the installed version.

## Bootstrap operation

`dotbabel bootstrap --projections` explicitly installs the package's fixed Claude release batch. The shell wrapper accepts `./bootstrap.sh --projections` and delegates to the same Node path. Both need a generated package baseline; absence fails with claude_baseline_unavailable. The baseline producer is P-16. No project routing policy is applied to shared user configuration.

The initial plain shell quickstart remains Node-free while no projection manifest exists. Once projection ownership exists, plain bootstrap uses the ownership-aware path and preserves installed copies. Explicit projection updates require Node, CLI dependencies and the P-13 Linux/Python atomic-exchange prerequisites. Unclaimed files, changed owned files and unowned directory symlinks are refused. Move any intentional user file to a chosen backup before requesting replacement. Companion assets use exclusive anchored links; existing user assets remain intact.

Five shell cases cover owned replacement versus unowned refusal, a regular generated skill copy, missing prerequisites, preservation of sibling CLI home directories and refusal of an occupied projection lock. A source-only fixture avoids changing this repository or live user configuration during any test. Project activation, ordinary MAIN routing, CLI setup/status and the final initiative audit remain OPEN.

Ordinary Node bootstrap holds the shared projection lock across legacy writers and refuses pending generations. The plain shell path reserves the same lock name with an exclusive directory while remaining Node-free. It rechecks projection state under that reservation before writing. A marked reservation is removed only by its holder; an interrupted shell reservation requires manual recovery. The existing Node lock logic treats unknown directory metadata conservatively and does not reclaim it. A real shell/Node process test pauses the shell at its first link, confirms that the Node projection installation returns busy, then releases the shell and verifies lock cleanup.

## Protected review corrections

The four-role review found three defects. Static artifacts without compute metadata now preserve runtime inheritance. Bootstrap rejects sibling CLI destinations that overlap the Claude agent, command or skill trees, including existing symlink aliases, before installation writes. This prevents cross-runtime fan-out from exposing canonical metadata through a protected generated skill.

Companion links use a separate operational ownership record, `.dotbabel-claude-companions.json`. Absolute source paths stay outside the deterministic projection identity. A release installed from a different package root updates only links whose current target matches recorded ownership. User files, changed user links and unowned links remain intact. A saved old/new transition permits recovery after an interrupted update. An interrupted first ownership save leaves the new link unowned; a later run preserves it conservatively. Unused companions remain intact while their ownership records retire.

Companion installation now holds the same projection lock through both changed and identical batch updates. Link replacement checks the actual displaced object through atomic exchange and restores a concurrent user replacement. Regression tests cover source-root changes, a third release after interruption, malformed ownership, user replacements and the atomic exchange boundary.
