# §8 — Risks and Alternatives

> This section does two jobs at once: it preserves design rationale so
> future contributors don't relitigate settled decisions, and it bounds
> scope creep so future PRs can't smuggle rejected paths back in as
> "small improvements." Read both halves with that frame; an entry that
> looks like preference is usually a constraint with a missing why.

## Risks

Each risk lists the **failure mode**, **likelihood**, **impact**, and
**mitigation**. Mitigations are concrete (a test that catches it, a
behavior that prevents it) — not "we'll be careful."

### R-1 — SKILL.md / binary contract failure (two failure modes)

Two distinct ways the auto-trigger contract can fail; each needs a
different mitigation.

| Sub-mode | Failure                                                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1a     | **Doc drift.** Binary surface changes; SKILL.md / `docs/handoff-guide.md` / `--help` not updated. Phrase mapping invokes a removed flag or stale verb.                                                     | ARCH-10 drift test (CI gate per OPS-1). Tests the symbol list, not prose; updates ride in the same PR as the binary change.                                                                                                                                               |
| R-1b     | **Runtime misinterpretation within one LLM.** SKILL.md is current, but the host LLM reads ambiguous trigger language and produces the wrong invocation (e.g. drops `--from`, picks the wrong sub-command). | SKILL.md trigger language is **imperative and example-anchored**: "when the user says X, run exactly `dotbabel handoff push --from <your-cli>`." No free-form "when the user wants to push…" phrasing. §5.5.1's mapping table is what gets quoted into SKILL.md verbatim. |

| Likelihood | Impact                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Medium     | High for R-1a (silently broken slash command); medium for R-1b (one wrong invocation, exit 64 surfaces it). |

### R-2 — Direct-shell user trips on `--from` mandatory

A user invoking `dotbabel handoff push` from a shell (not via slash
command) without `<query>` and without `--from` gets exit 64. They
hit it on the first major-version run after the migration; if the
error message is unclear, they bounce.

**Mitigation.** Exit-64 stderr template (per §5.3.3) reads:
`dotbabel-handoff: push: --from required when no <query> is given` +
usage block listing `--from claude|copilot|codex|gemini`. `docs/handoff-guide.md`
calls this out as the #1 gotcha in the migration section. CHANGELOG entry
for the major bump (per §6.5) lists `--from` mandatory as its own line.

| Likelihood | Impact                                     |
| ---------- | ------------------------------------------ |
| High       | Low (hit-once, recoverable, helpful error) |

### R-3 — Scrub pattern set misses a new secret format

The eight perl regex passes (SEC-1) cover the secret prefixes that
existed when this spec was written. A future cloud / API service ships
a new key prefix the patterns don't catch; user pushes; secret reaches
the private remote unscrubbed.

**Mitigation.** Two layers:

- **Process.** SEC-1 versions the pattern set; new patterns require a
  spec amendment + a corresponding bats test. The channel is open for
  additions.
- **Inherent limits, accepted by spec assumption.** Scrub is
  best-effort. The remote is private. The user is the **sole owner**
  of `$DOTBABEL_HANDOFF_REPO` by spec assumption (§3 ARCH-4 — one
  remote per user). If the user ever shares repo access (collaborator,
  org transfer, fork), the threat model changes — that's their call,
  not the spec's. The skill cannot defend against secrets in shared
  storage; it defends against secrets in a personal store the user
  controls.

| Likelihood | Impact                                                |
| ---------- | ----------------------------------------------------- |
| Medium     | Medium (private repo limits blast radius; user-owned) |

### R-4 — Cross-LLM divergence on the same SKILL.md

Three host LLMs (Claude Code and Copilot CLI auto-load SKILL.md;
Codex doesn't load it at all) may interpret the **same trigger doc
differently**. "push handoff" could resolve to `push` on one and
`push --tag handoff` on another. This is **distinct from R-1b**:
R-1b is a single LLM getting it wrong; R-4 is two LLMs disagreeing
on the same source.

**Mitigation.**

- SKILL.md uses literal command examples in §5.5.1's mapping
  (`dotbabel handoff push --from <your-cli> [--tag <label>]`) rather
  than free-form descriptions of intent. Less interpretive surface
  area.
- Binary-side `--from` mandatory (per ARCH-3) means a misinterpretation
  that picks the wrong source surfaces as exit 64 — not as a silent
  push of the wrong session.
- Codex never loads SKILL.md, so cross-LLM divergence is bounded to
  Claude vs. Copilot — two LLMs, not three. The codex-vs-others
  divergence is structural (Codex always uses the binary directly per
  `from-codex.md`), not a reading-comprehension failure.

| Likelihood | Impact                                                 |
| ---------- | ------------------------------------------------------ |
| Low-Medium | Low (binary-side checks catch the consequential cases) |

### R-5 — Drift-test infrastructure is brittle

A SKILL.md grammar quirk (a missing colon, a bullet style change, a
heading rename) breaks the drift test's symbol extractor. CI goes
red on PRs that didn't actually drift the contract.

**Mitigation.** Phase 1 (per §6.1) lands the drift test against the
**current (old) surface** before any cutover, so the test mechanism
is validated on a known-good baseline. Any extractor brittleness
surfaces in Phase 1 against today's SKILL.md, not in Phase 2 against
a moving target. The Phase 1 PR includes a fixture-based test of the
extractor itself (per §6.4 W-4 unit test).

| Likelihood | Impact                                            |
| ---------- | ------------------------------------------------- |
| Medium     | Low (false-positive CI red, fixed in the same PR) |

### R-6 — Codex's bash tool quotes arguments badly for `--from` filling

Codex's bash tool may shell-quote `--from claude` differently than
expected when the user uses Codex's natural-language → shell
translation (rather than typing the binary call directly).

**Mitigation.** `skills/handoff/references/from-codex.md` documents
the **direct-shell pattern explicitly**: users on Codex run
`!dotbabel handoff <verb> --from codex …`, not "ask Codex to push
this for me." The skill markdown is not loaded by Codex, so there's
no SKILL.md-mediated translation path that could double-quote.
Codex users are pushed onto the unambiguous direct-binary surface
by design.

| Likelihood | Impact                                                            |
| ---------- | ----------------------------------------------------------------- |
| Low        | Low (`from-codex.md` is the documented escape hatch; user reruns) |

### R-7 — Multi-machine push of the same source UUID

Edge case: the user manually copies a session JSONL from machine A to
machine B (or has it shared via Dropbox / iCloud / similar) and pushes
from both. Force-push policy (KD-1) means whoever pushes second wins.

**Mitigation.** This isn't a workflow the spec supports — the source
of truth for any session is the agent CLI's own session-state
directory, which is local to one machine. Manually replicating those
files is out of scope. KD-1's "second-writer-wins" is a derived
consequence, not a feature.

Logged here so future-you doesn't get confused investigating "why
did my morning push disappear" — it didn't, you just pushed the
same UUID from two machines and the later one overwrote.

| Likelihood | Impact                              |
| ---------- | ----------------------------------- |
| Very low   | Medium (one push lost, no recovery) |

### Risks intentionally not listed

| Non-risk                                                    | Why omitted                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch-name collision across the user's own sessions        | Birthday-paradox math on 8-hex-char short_id puts this in "more likely to be hit by lightning" tier; REL-2's collision probe handles it.        |
| Network failure mid-push                                    | Git refs are atomic; no partial state possible. The push either completed or didn't.                                                            |
| Substrate interface drift (extract.sh / resolve.sh changes) | Covered by the bats integration suite; not a category-level risk.                                                                               |
| User has to relearn verbs after the major bump              | That's how semver works. Listing it as a risk implies the design is doing something wrong; it isn't. Migration table in §6.5 is the affordance. |
| PERF-1's 1000-branch baseline turning out to be wrong       | §7 PERF-1 self-mitigates via "ceiling adjusts, behavior doesn't." Listing it here would be redundant.                                           |

## Rejected Alternatives

Each entry preserves the **path considered** and **why it's
rejected**, so future contributors don't relitigate the same
decisions. Treat A-N as boundary markers: a PR proposing one of
these must amend §8 first.

### A-1 — Keep `--to <cli>` for next-step text customization

**Path.** Preserve the cosmetic `--to` flag on `push` / `pull` /
local emit so the host LLM (or the user) can pre-tune the
"Next step" line for the target agent.

**Rejected.** The flag is purely cosmetic — one line of text per
target. It requires the user (or LLM) to predict where the block
will be pasted at the moment it's emitted; the host LLM at _paste
time_ already knows where the block is going. The ARCH-2 design
moves target inference to "wherever the block lands," eliminating
the prediction. §1's "redundant requirements" grievance applies.

### A-2 — Use env-var detection for source CLI

**Path.** Probe `CLAUDECODE`, `CODEX_*`, `GITHUB_COPILOT_*` /
`COPILOT_*` to auto-detect the source CLI at `push` time without
requiring `--from`.

**Rejected.** The probes admit `UNCONFIRMED` status in their own
implementation comments (legacy `detectHost()` in
`plugins/dotbabel/bin/dotbabel-handoff.mjs`).
An unreliable signal that silently picks the wrong source is exactly
the failure mode §1 was written to stop. KD-6 + ARCH-3 settle this:
SKILL.md fills `--from` for slash-command users (the host LLM
trivially knows its own identity); shell-direct users pass `--from`
explicitly. Never silently inferred.

### A-3 — Multi-PR deprecation cycle with warnings shipped to npm

**Path.** Land warnings for `--to`, old verbs, and env-detection
fallback in one release; ship the breaking changes in the next.

**Rejected.** Deprecation warnings on a personal-ish npm package
don't reach users in time — there's no dashboard, no email blast,
no CI fleet broadcasting them. They just create a half-state
codebase the maintainer must test and maintain twice. **Semver
major is the only signal that actually fires.** §6.1's release-bang
with phased PRs is the right shape.

### A-4 — Pre-write detailed per-PR prompts in §6.3

**Path.** Author 15-25 fully-fleshed implementation prompts in §6.3
with `<read-first>` file lists, TDD test names, exact paths, etc.

**Rejected.** Prompts rot. By the time PR #N is being worked on,
the codebase has moved past PR #(N-1)'s assumptions and the
pre-written prompt is stale. The discipline §1 wants is supplied
by (a) the spec existing and being referenced, (b) drift-test
failing on drift, (c) PRs scoped to single workstreams. Pre-written
prompts aren't on that list. §6.3's skeletal layout + pointer to
a future `docs/plans/handoff-skill-prompts.md` (written at
implementation kickoff, not now) is the right shape.

### A-5 — Auto-prune / TTL on the remote store

**Path.** Ship a `prune` sub-command (or background pruning) that
deletes branches older than N months / past M total / not tagged.

**Rejected.** No obvious default policy: delete-by-age? by project?
keep-tagged? Shipping defaults wrong is worse than not shipping
defaults. KD-3 explicitly de-scopes this; the user manages
retention with regular git operations
(`git push --delete origin <branch>` or batch-delete via `gh api`).
Restated as anti-NFR in §7 so future PRs can't slip it in via an
"operational" framing.

### A-6 — Drop `list` / `search` / `describe` / `doctor` entirely

**Path.** Strip the supporting commands so the surface is purely
`pull`, `push`, `fetch` and nothing else.

**Rejected.** §1 says supporting commands **feed the primaries**,
not that they don't exist. Without `list` / `search` the user has
no way to discover the right `<query>` to pass to `pull` or `fetch`
— they'd be back to `find ~/.codex/sessions -name 'rollout-*.jsonl'`
and `grep` against raw JSONL. `describe` is the preview before
committing to a paste. `doctor` is the only diagnostic when the
remote misbehaves. Each one earns its slot by feeding the primary
jobs; removing them re-creates the friction the redesign exists to
remove.

### A-7 — Real-time webhook / push notification on the remote

**Path.** Surface a notification on machine B when machine A pushes
a fresh handoff (webhook → desktop notification → IDE banner).

**Rejected.** `pull` and `fetch` are intentional acts of _starting
work_. Push notifications would mean a misfired handoff from
machine A interrupts machine B mid-thought. The async-by-default
behavior is the **feature**, not a limitation. The user pulls when
they sit down to start the next session, not when the network tells
them to.

### A-8 — Port the shell substrate to JS

**Path.** Move `handoff-resolve.sh`, `handoff-extract.sh`,
`handoff-scrub.sh`, `handoff-description.sh`, `handoff-doctor.sh`
into the `src/lib/` Node modules.

**Rejected.** The per-CLI jq filters in `handoff-extract.sh` took
multiple PRs to harden (pruning system-reminder noise from Claude
prompts, handling Copilot's transformedContent vs content
preference, Codex's `<environment_context>` filter). Porting buys
nothing user-facing — `--help`, behavior, exit codes are all
identical — and risks regression on substrate that works. §2
explicitly froze the substrate; restated here so a future "let's
unify the runtime" PR can't smuggle this past spec review.

### A-9 — Use a non-git transport (S3, raw HTTPS, Notion, gist-token)

**Path.** Replace or add to the git-repo transport with an
alternative store.

**Rejected.** Git is the substrate the user already authenticates
against (SSH key, credential helper, or `gh` token). Commit
messages double as an LLM-readable index without a separate index
format. No new credential to rotate. Plus: gist transports were
already removed in PR #68 because of the gh-scope friction; they
should not return. Any new transport adds an authentication problem
the spec explicitly doesn't want to own.

### A-10 — E2E-encrypt payloads with the user's SSH key

**Path.** Encrypt `handoff.md` / `metadata.json` client-side before
push using the user's existing SSH key; decrypt on fetch.

**Rejected.** The repo is private; GitHub is already trusted with
the user's source code (which is far more sensitive than handoff
digests typically are). E2E adds a key-rotation problem (what
happens when the user generates a new SSH key? are old branches
still readable?) that §2 explicitly de-scopes. Best-effort scrub

- private repo + sole-owner assumption (R-3) is the threat model.

### A-11 — Auto-inject the digest into the target agent

**Path.** Use clipboard, prefilled prompt injection, or IPC to
deliver the `<handoff>` block to the next agent without manual
paste.

**Rejected.** Paste is a **deliberate human checkpoint** per
`SKILL.md`'s `## Out of scope` section and reaffirmed in §2. Auto-injection means a
wrong-session handoff (e.g. R-7's "pushed wrong UUID" scenario)
silently contaminates the next agent's context with no user
verification step. The paste step is where the user reads the
`<handoff origin="…" session="…" cwd="…">` attributes and confirms
"yes, this is the session I meant." Removing it eliminates the
audit point.

### A-12 — Add Cursor / Aider / Continue / [next agent]

**Path.** Extend the supported-CLI set beyond claude / copilot /
codex.

**Rejected.** Each new agent needs a substrate pair
(`resolve_<cli>` in `handoff-resolve.sh`, per-CLI jq filters in
`handoff-extract.sh`) and a SKILL.md trigger update. That's real
recurring work for speculative demand. **Three agents is the user's
actual workflow**; spec amendment is the channel for additions
when demand is concrete. §2 already lists this as out-of-scope;
restated here so "we should add Cursor support, it's small" can't
slip in as a one-liner PR.

## Cross-references

- §1 — the "redundant requirements" framing that A-1, A-2, A-5 rejections invoke.
- §2 — out-of-scope list that several rejections reference.
- §3 ARCH-4 (one remote per user) — load-bearing assumption for R-3 and A-10.
- §3 ARCH-10 — drift-test mechanism that R-1a relies on.
- §4 KD-1 — force-push policy that R-7 derives from.
- §4 KD-3 — store retention de-scope that A-5 reaffirms.
- §4 KD-6 — `--from` filling rule that R-1b's mitigation depends on.
- §5.5 — phrase mapping that the "imperative + example-anchored" mitigation in R-1b quotes verbatim.
- §6.1 — Phase 1 baseline that R-5's mitigation depends on.
- §7 SEC-1 — versioned scrub patterns referenced by R-3.
- §7 anti-NFRs — A-5, A-7's secondary anchor.
