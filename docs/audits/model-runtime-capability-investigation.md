# Dotbabel Runtime Model Capability Investigation

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Date            | 2026-09-17                                                                                                  |
| Repository      | `kaiohenricunha/dotbabel` @ `0db0221` (`main`), package `3.4.0`                                             |
| Predecessor     | [`model-selection-audit.md`](./model-selection-audit.md)                                                    |
| Type            | Empirical investigation. No design, no implementation.                                                      |
| Deliverable     | This file only. No production code, schema, agent, skill, command, template, or harness config was changed. |
| Host            | WSL2 (`Linux 6.6.87.2-microsoft-standard-WSL2`), node `v22.22.2`                                            |
| Evidence labels | `CONFIRMED` / `LIKELY` / `UNCERTAIN` / `BLOCKED`                                                            |

---

## Executive Summary

### Runtimes tested

| Runtime            | Executable | Version observed             | Live-invocation experiments         | Static + read-only experiments |
| ------------------ | ---------- | ---------------------------- | ----------------------------------- | ------------------------------ |
| Claude Code        | `claude`   | `2.1.274 (Claude Code)`      | **yes** (authenticated)             | yes                            |
| Codex CLI          | `codex`    | `codex-cli 0.154.0`          | **yes** (unauthenticated)           | yes                            |
| Gemini CLI         | `gemini`   | `0.59.0`                     | partial (auth-blocked)              | yes                            |
| Antigravity CLI    | `agy`      | `1.2.5`                      | **BLOCKED** (auth)                  | yes                            |
| GitHub Copilot CLI | `copilot`  | `GitHub Copilot CLI 1.0.83.` | partial (auth-blocked)              | yes                            |
| OpenCode           | `opencode` | `opencode v2.0.5`            | partial (no providers in isolation) | yes                            |

### Experiments completed — 24; blocked — 4

**Completed:** version/help capture ×6; config-root isolation verification ×3; Codex resolved-config probes ×8; Codex config-key recognition ×15; Codex model catalog + stability + offline ×5; Gemini skill-discovery frontmatter ×2; Copilot skill-list frontmatter ×1; Antigravity binary YAML-tag analysis ×2; Claude precedence Cases A/B/C/D + discriminators ×10; Claude skill-`model` test; Claude command-`model` test; Claude skill-`effort` test ×5; `agy models` ×3; `opencode models` ×11; failure-behaviour probes ×12.

**Blocked:** (1) Antigravity live frontmatter invocation — isolated `HOME` has no credentials and the CLI opens an interactive OAuth flow; (2) OpenCode live invocation — an isolated config root has zero providers, so no model can run; (3) Copilot live invocation — isolated `COPILOT_HOME` has no GitHub auth; (4) Gemini live invocation — isolated `GEMINI_HOME` has no auth method. In every case the alternative was to copy real credentials into a temp root, which the isolation contract forbids.

### Strongest confirmed findings

1. **Claude Code treats `model:` differently on agents, commands, and skills — and Dotbabel's 36 skills are the inert case.** `CONFIRMED` by three controlled runs. An **agent** with `model: opus` in a `--model haiku` session runs on `claude-opus-5[1m]`. A **command** with `model: opus` in a `--model haiku` session moves the _whole session_ to `claude-opus-5`. A **skill** with `model: opus` + `effort: max` in a `--model haiku` session runs entirely on `claude-haiku-4-5-20251001`. The previous audit treated all three as one class; they are three different mechanisms.

2. **Dotbabel's skill `effort:` has no observable effect, and the measurement instrument was validated against positive controls.** `CONFIRMED`. Using `result.modelUsage[*].thinkingTokens` from `--output-format stream-json`: session `--effort low` → 78, 77 vs `--effort max` → 148, 262 (separates); agent-level `effort` → 53 vs 130 (separates); **skill-level `effort: low` → 673, 578 vs `effort: max` → 776, 679 vs no `effort:` → 846** (fully overlapping, and the _control_ is highest). The same metric detects effort where it is honoured and detects nothing on a skill. Verdict: `NO_OBSERVABLE_EFFECT`.

3. **Codex CLI ships a complete, structured, offline, deterministic model catalog — and the previous audit said it had none.** `CONFIRMED`. `codex debug models` returns 518,257 bytes of JSON, 11 models, byte-identical across 3 runs, exit 0, **with the network blocked** and **with no credentials**. Each entry carries `slug`, `default_reasoning_level`, `supported_reasoning_levels` (array of `{effort, description}`), `context_window`, `support_verbosity`, `visibility`, `multi_agent_reasoning_effort`.

4. **Effort support varies per model, proven from a vendor's own catalog.** `CONFIRMED`. Of Codex's 11 models, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2` support only `low/medium/high/xhigh` — **they do not support `max`**. Dotbabel ships `effort: max` on 11 skills. A future resolver cannot treat effort as a model-independent axis.

5. **Copilot CLI reads `.claude/skills/` and `.agents/skills/` directly — Dotbabel's runtime registry says it has no skills directory at all.** `CONFIRMED` by `copilot skill list --json` in an isolated `COPILOT_HOME`: probes planted in a project's `.claude/skills/` and `.agents/skills/` were both listed with `source: "project"`, `enabled: true`. `plugins/dotbabel/src/agents.mjs:238` declares `globalSkills: null` and `projectFanOut: {kind: "copilot-files"}` for Copilot. Dotbabel already writes `.agents/skills/` for Antigravity, so **Copilot has been silently reading Dotbabel's Antigravity tree**, including the seven command copies that carry `model: haiku` / `model: sonnet`.

6. **Antigravity has no YAML `effort` field anywhere in its binary.** `CONFIRMED`. Exhaustive tag search of `agy` 1.2.5 (217 MB ELF): `yaml:"effort"` = 0, `yaml:"effort,omitempty"` = 0, while `json:"effort,omitempty"`, `json:"effortByBase,omitempty"`, `json:"effortSelector"`, `json:"reasoning_effort,omitzero"` all exist. Effort is a wire/settings concept in Antigravity, never a frontmatter one.

7. **The `-high` suffix in `agy models` is not a decomposable effort field — verified, not assumed.** `CONFIRMED`. The 14 IDs use an inconsistent suffix vocabulary: `gemini-3.8-flash` has high/medium/low, `gemini-3.1-pro` has only high/low (**no medium**), `claude-opus-4-6-thinking` uses `-thinking` in the same slot, `claude-sonnet-4-6` has **no suffix at all** yet its label reads `(Thinking)`, and `gpt-oss-120b-medium` has `-medium` with no siblings. The internal representation is `effortByBase` / `effortSelector`, i.e. the CLI itself keeps effort keyed by base model and renders a fused selector ID.

8. **`opencode models` returns zero lines with exit code 0 on a cold start.** `CONFIRMED`, observed twice. Warm: 9 lines, byte-identical across 6 consecutive runs. Cold (and under `--standalone`, even against the real config): 0 lines, exit 0, empty stderr. Any parser trusting the exit code would conclude "no models exist".

9. **Every runtime accepts an unknown model without client-side validation; effort validation is the opposite and is inconsistent.** `CONFIRMED`. Unknown model: Codex writes it verbatim into resolved config; Gemini, Antigravity, Copilot reach auth before validating; only **Claude Code** rejects synchronously (`exit 1`, `[claude-code:unrecognized_model]`). Unknown effort: **Copilot rejects at the arg parser** (exit 1, prints the 7-value enum); **Claude warns and silently falls back to default** (exit 0, prints the 5-value enum); **Codex accepts any string** into resolved config (`reasoning effort: dotbabel-nonexistent-effort`) while validating a _sibling_ key (`model_verbosity`) as a strict enum.

10. **A Claude subagent whose `model:` does not exist fails without failing the session.** `CONFIRMED`. `[claude-code:unrecognized_model]` with `query_source: "agent:custom:dbp"` appears on the stream, yet `is_error: false`, exit 0, and the run reports success. Silent degradation of a delegated step.

11. **`agy` self-updated mid-investigation, from 1.2.4 to 1.2.5, in under four hours.** `CONFIRMED`. The earlier audit recorded 1.2.4 at ~12:19 today; `/home/kaiocunha/.local/bin/agy` has mtime `2026-09-17 12:31`, and it now reports 1.2.5. `agents.mjs:272,279` pins observed facts to "agy v1.2.4" in comments. Version-stamped capability knowledge decays on a timescale of hours, not releases.

12. **"Auto mode" means three unrelated things across three runtimes.** `CONFIRMED`. Gemini represents auto routing **as a model ID** (`DEFAULT_GEMINI_MODEL_AUTO = "auto-gemini-2.5"`). Copilot represents it **as a model value** (`--model auto`) plus an automatic _fallback into_ auto mode on rate-limit errors. Claude Code's `claude auto-mode` is **not model routing at all** — it is a permission classifier whose config keys are `allow`, `soft_deny`, `hard_deny`, `environment`, with zero occurrences of `model` or `effort`.

### Direct answers

- **Is Dotbabel's `model:` frontmatter meaningful outside Claude Code?** **No.** `CONFIRMED` for Gemini and Copilot (discovered, enabled, no warning, no model/effort field in either listing); `LIKELY` for Codex (its bundled SKILL.md validator's allowlist is `{name, description, license, allowed-tools, metadata}`) and Antigravity (no YAML model/effort deserialization for skills). And it is **only partly** meaningful inside Claude Code: honoured on agents and commands, inert on skills.
- **Does Dotbabel's `effort:` frontmatter have observable runtime effect?** **No, on any runtime tested.** `CONFIRMED` for Claude Code with a validated instrument; `CONFIRMED` not-parsed for Antigravity; `CONFIRMED` not-surfaced for Gemini and Copilot; `LIKELY` not-parsed for Codex; `BLOCKED` for OpenCode live behaviour.
- **Which runtimes provide usable model discovery?** Codex (STRUCTURED, offline, deterministic, no auth) ≫ Copilot (PARSEABLE_TEXT enum in `copilot help config`, 26 models) > Antigravity (PARSEABLE_TEXT, TSV, stable) > OpenCode (PARSEABLE_TEXT but silently-empty failure mode; plus STRUCTURED JSON for locally-declared providers) > Gemini (NONE exposed) = Claude Code (NONE — it can report the _active_ model but cannot enumerate available ones).
- **Which unknowns still block architecture work?** Three: OpenCode's skill-frontmatter behaviour, Antigravity's skill-frontmatter behaviour, and whether any runtime other than Claude Code can report its _active_ model to a caller. Everything else needed to design the data model is now evidence-backed.

---

## Environment

All figures captured 2026-09-17 16:24–17:10 UTC.

```
Host      Linux win11 6.6.87.2-microsoft-standard-WSL2 x86_64 (WSL2)
Shell     /usr/bin/zsh  (all experiments run under `bash -c` for POSIX semantics)
node      v22.22.2
```

| Runtime  | Binary path (resolved)                                                            | Kind           |
| -------- | --------------------------------------------------------------------------------- | -------------- |
| claude   | `~/.local/share/claude/versions/2.1.274`                                          | native build   |
| codex    | `~/.nvm/.../@openai/codex/bin/codex.js` → `@openai/codex-linux-x64/.../bin/codex` | JS shim + Rust |
| gemini   | `~/.nvm/.../@google/gemini-cli/bundle/gemini.js`                                  | JS bundle      |
| agy      | `~/.local/bin/agy`                                                                | Go ELF, 217 MB |
| copilot  | `~/.nvm/.../@github/copilot/npm-loader.js`                                        | JS             |
| opencode | `~/.nvm/.../@opencode/cli/bin/opencode.exe`                                       | ELF, 213 MB    |

Auto-update evidence (`CONFIRMED`): `agy` binary mtime `2026-09-17 12:31:08`, now reporting `1.2.5` where the same probe returned `1.2.4` at ~12:19 the same day. Claude Code keeps `2.1.270, 2.1.271, 2.1.273, 2.1.274` side by side under `~/.local/share/claude/versions/`.

Stream-hygiene note (`CONFIRMED`): `agy --help` writes **2852 bytes to stderr and 0 to stdout**. Every other CLI writes help to stdout. Any generic help-scraping helper must read both streams.

---

## Experimental Safety and Isolation

### Config roots identified before invocation

| Runtime     | Isolation variable(s) used                          | Verified how                                                                                                                                                                                                |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | `OPENCODE_CONFIG_DIR`, `HOME`, `XDG_CONFIG_HOME`    | `opencode debug paths` printed `config → $ISO/oc` and data/cache/state/db under `$ISO/home` `CONFIRMED`                                                                                                     |
| Codex       | `CODEX_HOME`, `HOME`                                | `codex doctor --json` reported `checks["config.load"].details.CODEX_HOME = $ISO/ch` and `config.toml → [$ISO/ch/config.toml, "missing"]` `CONFIRMED`                                                        |
| Copilot     | `COPILOT_HOME`, `HOME`                              | `copilot help environment`: "`COPILOT_HOME`: override the directory where configuration and state files are stored; defaults to `$HOME/.copilot`"; probe skills resolved under `$ISO/ch/skills` `CONFIRMED` |
| Gemini      | `GEMINI_HOME`, `HOME`                               | `gemini skills list` reported probe `Location: $ISO/home/.gemini/skills/...` `CONFIRMED`                                                                                                                    |
| Antigravity | `ANTIGRAVITY_CONFIG_HOME`, `HOME`                   | isolation achieved, but the run then required interactive OAuth → experiment **BLOCKED**                                                                                                                    |
| Claude Code | project-scope temp dir + `--no-session-persistence` | `--no-session-persistence` is documented as "sessions will not be saved to disk"; agents supplied via `--agents <json>` so **no file under `~/.claude` was created or edited** `CONFIRMED`                  |

Every isolated invocation used `env -i PATH=... HOME=...` so no ambient variable leaked in.

### Verification that real configuration was not mutated

Directory mtimes after all experiments (experiments ran from 16:24 onward):

```
2026-09-16 17:38:01  $HOME/.codex
2026-09-17 11:59:34  $HOME/.gemini
2026-09-17 11:59:35  $HOME/.config/opencode
2026-09-16 17:38:01  $HOME/.copilot
2026-09-17 13:23:33  $HOME/.claude/settings.json   (written by the live Claude Code session itself, not by an experiment)
```

No harness config directory has a post-16:24 mtime. `CONFIRMED`.

### What was deliberately not done

- No account was authenticated. The Antigravity probe printed an OAuth URL and was allowed to time out; the URL's `client_id`/`code_challenge`/`state` are ephemeral PKCE values and are **not reproduced here**.
- No credentials were copied into any temp root.
- No CLI was installed, updated, or reconfigured.
- Nothing was written outside `mktemp -d` roots, the session scratchpad, and this report.
- Repository source was never sent to a provider. The only content reaching a model was the synthetic probes (`Reply with exactly: OK`, `Output exactly: DOTBABEL_MODEL_PROBE`, `What is 5273 multiplied by 8419?`).
- Claude Code experiments used the real user credentials (there is no isolated way to authenticate one). They wrote no session transcript. This is the one experiment class that was **not** credential-isolated, and it is disclosed here rather than presented as isolated.

### Side effects worth recording

- `opencode` created the shared scratch directory `/tmp/opencode` (reported by `debug paths` as a fixed path, outside any config root).
- Codex emitted `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"` on every isolated run — a self-protective refusal that also confirms it honoured the isolated `CODEX_HOME`.
- Cleanup removed `/tmp/tmp.*` scratch directories. This pattern is broader than the ~25 this investigation created; see the closing note in the response accompanying this report.

### Probe artifacts

Five minimal variants, identical bodies, differing only in frontmatter. Exact contents:

```yaml
# control.md
---
name: dbprobe-control
description: Deterministic Dotbabel probe. Use when the user says dbprobe.
---
Output exactly: DOTBABEL_MODEL_PROBE
```

```yaml
# dotbabel.md — Dotbabel's real shipped shape
---
name: dbprobe-dotbabel
description: Deterministic Dotbabel probe. Use when the user says dbprobe.
model: opus
effort: max
---
Output exactly: DOTBABEL_MODEL_PROBE
```

```yaml
# invalid.md
---
name: dbprobe-invalid
description: Deterministic Dotbabel probe. Use when the user says dbprobe.
model: dotbabel-nonexistent-model
effort: dotbabel-nonexistent-effort
---
Output exactly: DOTBABEL_MODEL_PROBE
```

`modelonly.md` and `effortonly.md` are `dotbabel.md` with the other key deleted. Claude-specific variants (`dbskill`, `dbeffort`, `dbcmd`, `dbtools`) are quoted inline in their sections.

---

## Runtime Capability Matrix

| Runtime            | Version | Model selector                                                                                      | Effort selector                                                     | Native effort values                                                                        | Model discovery                                                                                                                     | Auto/Adaptive                                                                   | Fallback                                                          | Model/effort representation                                                                                                                                                            | Discovery quality                                            |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Claude Code        | 2.1.274 | `--model <alias\|full>` (aliases incl. `fable`, `opus`, `sonnet`); agent `model:`; command `model:` | `--effort <level>`; agent-level `effort` key (undocumented in help) | `low, medium, high, xhigh, max` — printed verbatim by the CLI's own warning                 | **none** — no list flag or subcommand. Active model observable via `stream-json` `system/init.model` + `result.modelUsage`          | `claude auto-mode` exists but is a **permission** classifier, not a router      | **`--fallback-model <list>`** — comma-separated, retried per turn | **separate**; resolved id may carry a context variant (`claude-opus-5[1m]`); `modelUsage` exposes `canonicalModel` + `provider`                                                        | **NONE** for availability; STRUCTURED for the active model   |
| Codex CLI          | 0.154.0 | `-m/--model`, `-c model=…`                                                                          | `-c model_reasoning_effort=…`                                       | per model, from the catalog: `low, medium, high, xhigh, max, ultra` (subset varies)         | **`codex debug models`** → JSON; `codex doctor --json` → resolved config; `codex exec` banner → resolved model/provider/effort      | not exposed as a flag; `codex-auto-review` is a catalog entry                   | not a config key (`fallback_model` = UNKNOWN_KEY)                 | **separate**; `model_provider` is its own resolved field; `ultra` fuses effort with delegation                                                                                         | **STRUCTURED**                                               |
| Gemini CLI         | 0.59.0  | `-m/--model`                                                                                        | **none**                                                            | n/a at CLI level; internal `thinkingConfig` / `thinkingBudget` / `thinkingLevel` (`"HIGH"`) | **none exposed**; bundle contains `listModels` + `/v1beta/models` but no subcommand                                                 | **`DEFAULT_GEMINI_MODEL_AUTO = "auto-gemini-2.5"`** — auto is a _model id_      | not exposed                                                       | **fused into the auto model id**; no user-facing effort axis                                                                                                                           | **NONE**                                                     |
| Antigravity CLI    | 1.2.5   | `--model`                                                                                           | `--effort`                                                          | `low\|medium\|high` (from help)                                                             | **`agy models`** → TSV `id<TAB>label`                                                                                               | not exposed as a flag                                                           | not exposed                                                       | **fused in the listed ID** (`gemini-3.8-flash-high`); internally `effortByBase` / `effortSelector`                                                                                     | **PARSEABLE_TEXT**                                           |
| GitHub Copilot CLI | 1.0.83  | `--model`, `COPILOT_MODEL`, `/model`                                                                | `--effort` / `--reasoning-effort`; config `effortLevel`             | `none, minimal, low, medium, high, xhigh, max` — enforced by the arg parser                 | **`copilot help config`** enumerates 26 model ids; `copilot providers` for BYOK                                                     | **`--model auto`**, plus automatic switch _into_ auto mode on rate-limit errors | auto-mode switch-and-retry on eligible rate-limit errors          | **separate, three axes**: `model` + `effortLevel` + `contextTier`, each settable per subagent and each accepting `"inherit"`; BYOK splits `PROVIDER_MODEL_ID` vs `PROVIDER_WIRE_MODEL` | **PARSEABLE_TEXT**                                           |
| OpenCode           | 2.0.5   | `run --model provider/model#variant`                                                                | **none** (`--thinking` only shows thinking blocks)                  | n/a                                                                                         | **`opencode models`** → newline `provider/model`; **`opencode debug config`** → JSON config sources; `opencode debug agents` → JSON | not exposed                                                                     | not exposed                                                       | **three-part id**: `provider/model#variant`; variants are **not** enumerated by `models`                                                                                               | **PARSEABLE_TEXT** (list) + **STRUCTURED** (declared config) |

Evidence class for every row: **runtime** (installed-CLI `--help`, subcommand help, read-only commands, or binary/bundle introspection). No row relies on external documentation.

---

## Frontmatter Behaviour

### Results matrix

| Harness                   | CLI version | `model: opus`                | invalid `model`                 | `effort: max`                        | invalid `effort` | Observable interpretation                                                                                                                                              | Confidence                               |
| ------------------------- | ----------- | ---------------------------- | ------------------------------- | ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Claude Code — **skill**   | 2.1.274     | **IGNORED**                  | IGNORED                         | **IGNORED**                          | IGNORED          | Skill invoked, body executed, session stayed on `claude-haiku-4-5-20251001`; `modelUsage` had exactly one model                                                        | `CONFIRMED`                              |
| Claude Code — **agent**   | 2.1.274     | **HONOURED**                 | REJECTED (per-agent, non-fatal) | **HONOURED** (as an `effort` key)    | not tested       | `claude-opus-5[1m]` appeared in `modelUsage`; agent `effort` low→53 vs max→130 thinking tokens                                                                         | `CONFIRMED` (model) / `LIKELY` (effort)  |
| Claude Code — **command** | 2.1.274     | **HONOURED**                 | not tested                      | n/a (no `effort` on commands tested) | n/a              | `system/init.model` became `claude-opus-5`; **whole session** switched                                                                                                 | `CONFIRMED`                              |
| Codex CLI                 | 0.154.0     | **NOT_PARSED**               | NOT_PARSED                      | **NOT_PARSED**                       | NOT_PARSED       | Bundled SKILL.md validator's `allowed_properties = {"name","description","license","allowed-tools","metadata"}`; `model`/`effort` outside it                           | `LIKELY`                                 |
| Gemini CLI                | 0.59.0      | **IGNORED**                  | **IGNORED**                     | **IGNORED**                          | **IGNORED**      | All 5 variants listed `[Enabled]`; zero warnings; listing exposes only name/description/location                                                                       | `CONFIRMED`                              |
| Antigravity CLI           | 1.2.5       | **UNCERTAIN** (live BLOCKED) | UNCERTAIN                       | **NOT_PARSED**                       | NOT_PARSED       | No `yaml:"effort"` tag exists in the binary; a single `yaml:"model,omitempty"` exists but could not be attributed to skill frontmatter                                 | `CONFIRMED` (effort) / `BLOCKED` (model) |
| GitHub Copilot CLI        | 1.0.83      | **IGNORED**                  | **IGNORED**                     | **IGNORED**                          | **IGNORED**      | All 5 variants in `copilot skill list --json` with `enabled: true`; entry keys are `name, description, source, path, enabled` — no model, no effort; no stderr warning | `CONFIRMED`                              |
| OpenCode                  | 2.0.5       | **BLOCKED**                  | BLOCKED                         | BLOCKED                              | BLOCKED          | No read-only skill-listing command; `opencode debug agents` hung (exit 124) under an isolated config; live run impossible without providers                            | `BLOCKED`                                |

No result is recorded as HONOURED on the basis of a successful invocation. Each HONOURED cell is backed by a model identifier or thinking-token measurement that changed.

### Claude Code

Three separate mechanisms, established by three controlled runs. Session model held at `haiku` throughout; the probe bodies were byte-identical apart from frontmatter.

**Skill — IGNORED.** Project-scope `.claude/skills/dbskill/SKILL.md` with `model: opus` and `effort: max`:

```
claude -p "Invoke the dbskill skill now, then reply exactly: DONE" --model haiku \
  --output-format stream-json --verbose --no-session-persistence --allowedTools "Skill,Read"
→ exit 0
  session init.model : claude-haiku-4-5-20251001
  modelUsage         : claude-haiku-4-5-20251001
  result             : DOTBABEL_MODEL_PROBE
```

The skill body ran (its exact output is the result) and no second model was billed. `CONFIRMED`. Mechanistically a skill is a prompt injection, not a separate model call, so there is no call for a `model:` to retarget — which is why the field is structurally inert rather than merely unread.

**Command — HONOURED, and session-wide.** Project-scope `.claude/commands/dbcmd.md` with `model: opus`:

```
claude -p "/dbcmd" --model haiku --output-format stream-json --verbose --no-session-persistence
→ exit 0
  session init.model : claude-opus-5      ← note: init, not a sub-call
  modelUsage         : claude-opus-5      ← haiku never ran at all
  result             : DOTBABEL_MODEL_PROBE
```

`CONFIRMED`. The command's `model:` is resolved **before session init** and replaces the user's `--model` for the entire session. This is the highest-impact frontmatter field Dotbabel ships and the audit did not distinguish it.

**Agent — HONOURED, scoped.** See [Claude Model and Effort Precedence](#claude-model-and-effort-precedence).

### Codex CLI

No `skills` subcommand exists and `codex --help` never says "skill", but the runtime does support skills: the native binary contains 100 `SKILL.md` literals and the path literal `/.codex/skills`, so Dotbabel's `.codex/skills` fan-out target is correct. `CONFIRMED`.

The binary embeds a **Python** SKILL.md validator whose allowlist is explicit:

```
    allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}
    unexpected_keys = set(frontmatter.keys()) - allowed_properties
        f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
```

`model` and `effort` are outside that set. The adjacent messages (`skill ... frontmatter field 'disable-model-invocation' must be false`, `Frontmatter must be a YAML dictionary`) show it is a real validator. **But these are Python f-strings — a bundled authoring/lint asset — and I could not prove it runs in the CLI's Rust skill loader.** The Rust side does contain the literals `allowed-tools` and `disable-model-invocation`. Verdict: `LIKELY NOT_PARSED`, not CONFIRMED. Distinguishing the two would need a live authenticated Codex session with a planted skill.

### Gemini CLI

`gemini skills list --all` under an isolated `HOME` + `GEMINI_HOME`, with all five probes at user scope:

```
exit=0   (7 skills discovered: 5 probes + 2 built-ins)
dbprobe-control    [Enabled]   Location: $ISO/home/.gemini/skills/dbprobe-control/SKILL.md
dbprobe-dotbabel   [Enabled]   ...
dbprobe-effortonly [Enabled]   ...
dbprobe-invalid    [Enabled]   ...
dbprobe-modelonly  [Enabled]   ...
stderr grep -iE "model|effort|unknown|unexpected|invalid|warn" → no matches
```

All variants — including `model: dotbabel-nonexistent-model` / `effort: dotbabel-nonexistent-effort` — are discovered and enabled with no warning and no difference from the control. The listing surfaces only name, description, and location. **IGNORED**, `CONFIRMED`.

Bundle corroboration: Gemini has an internal thinking axis (`thinkingConfig` ×109, `thinkingBudget` ×41, `thinkingLevel` ×11, `includeThoughts` ×14, e.g. `thinkingLevel: ThinkingLevel.HIGH`) and **zero** occurrences of `reasoningEffort`. So the concept exists internally under a different name and is reachable from neither the CLI nor frontmatter.

Separate operational finding (`CONFIRMED`): with the probes at **project** scope instead, Gemini refused to load them —

```
stderr: Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.
stderr: Project hooks disabled because the folder is not trusted.
```

Dotbabel's `.gemini/skills` project fan-out is invisible in an untrusted folder, independent of any model question.

### Antigravity CLI

Live invocation **BLOCKED**: an isolated `HOME` has no credentials, and `agy --print` opens an interactive Google OAuth flow ("Authentication required. Please visit the URL to log in… Waiting for authentication (timeout 60s)"), which was allowed to time out (exit 124). Authenticating would have violated the isolation contract.

Static evidence instead, from the 217 MB Go binary:

```
yaml:"model"                 0
yaml:"effort"                0
yaml:"model,omitempty"       1
yaml:"effort,omitempty"      0
json:"model"                 2
json:"effort"                0

all yaml tags containing model|effort:   yaml:"disable-model-invocation" , yaml:"model,omitempty"
all json tags containing effort:         json:"effort,omitempty" , json:"effort,omitzero" ,
                                         json:"effortByBase,omitempty" , json:"effortSelector" ,
                                         json:"reasoning_effort,omitzero"
```

`CONFIRMED`: no YAML `effort` field is deserialized anywhere in `agy` 1.2.5, so skill-frontmatter `effort:` is `NOT_PARSED`. The YAML tag pool visible near `*customizations.AgentFrontmatter` is `name, description, disable-model-invocation, disable-slash-command, metadata, enabled, glob, globs, icon, trigger, version, publisher, layout, filename, compress, id, value, type_name, logo, localtime, maxage, maxbackups, maxsize` — no `model`. The single `yaml:"model,omitempty"` could not be attributed to a specific struct (context extraction returned nothing), so skill `model:` remains `UNCERTAIN`.

### GitHub Copilot CLI

`copilot skill list --json` under an isolated `COPILOT_HOME`, unauthenticated, exit 0:

```
dbproj-agents       | project          | true | $ISO/proj/.agents/skills/dbproj-agents
dbproj-claude       | project          | true | $ISO/proj/.claude/skills/dbproj-claude
dbprobe-control     | personal-copilot | true | $ISO/ch/skills/dbprobe-control
dbprobe-dotbabel    | personal-copilot | true | $ISO/ch/skills/dbprobe-dotbabel
dbprobe-effortonly  | personal-copilot | true | $ISO/ch/skills/dbprobe-effortonly
dbprobe-invalid     | personal-copilot | true | $ISO/ch/skills/dbprobe-invalid
dbprobe-modelonly   | personal-copilot | true | $ISO/ch/skills/dbprobe-modelonly
customize-cloud-agent | builtin        | true | .../builtin/customize-cloud-agent
github-pr-media       | builtin        | true | .../builtin/github-pr-media
```

Entry keys are exactly `name, description, source, path, enabled`. All variants enabled, no warning. **IGNORED**, `CONFIRMED`.

The `dbproj-*` rows are the important ones. `copilot skill --help` states the discovery set and the run confirms it:

> Project `.github/skills/`, `.agents/skills/`, or `.claude/skills/` · Personal `~/.copilot/skills/` or `~/.agents/skills/`

Dotbabel's registry (`plugins/dotbabel/src/agents.mjs:229-240`) says the opposite: `globalSkills: null`, `projectFanOut: {kind: "copilot-files"}`, with the comment "Copilot CLI has no skill auto-discovery dir". Version 1.0.83 has one, and it overlaps two trees Dotbabel already writes.

Note the consequence for the frontmatter question specifically: Copilot's `.prompt.md` / `.instructions.md` generator correctly strips `model`/`effort` (`copilot-frontmatter.mjs:46,60`), but the **same skills reach Copilot a second time through `.claude/skills/` and `.agents/skills/` with frontmatter intact**. The stripping is bypassed by a path Dotbabel does not know Copilot reads.

### OpenCode

**BLOCKED.** OpenCode 2.0.5 exposes no read-only skill-listing command (`opencode debug` offers only `agents`, `config`, `paths`). Under an isolated config root, `opencode debug agents` hung and was killed at the 120 s timeout (exit 124, 0 bytes) — the background service cannot come up without a configured provider. Against the real config the same command returns structured JSON, but that would test the user's live configuration rather than a planted probe, and planting probes in the real config root is forbidden.

What is known without a live run: `opencode debug agents` (real config) returns 7 built-in agents with keys `id, name, request, description, mode, hidden, permissions`; **`model` is `undefined` on all seven**, and `request` carries only `settings, headers, body`. So OpenCode agents do not pin models by default, and no agent-level model field was observed.

---

## Claude Model and Effort Precedence

### Method

All runs: `claude -p … --output-format stream-json --verbose --no-session-persistence --allowedTools "Task,Read"`, agents defined inline with `--agents <json>` so nothing was written under `~/.claude`. Evidence is `system/init.model` and `result.modelUsage` keys, plus `result.subagent_stats`.

### A false start, corrected

The first Case A run used `model: haiku` for the agent against `--model sonnet`, and `modelUsage` showed both models. That looked like proof. It was not: the `inherit` and omitted controls **also** showed haiku, because Claude Code uses haiku for internal auxiliary work. The experiment was redone with `opus` as a discriminator (opus is never used for internal tasks), which separates cleanly:

| Case              | Agent `model:` | Session `--model` | `result.modelUsage`                                                     | Subagent effectively ran on            |
| ----------------- | -------------- | ----------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| A (discriminator) | `opus`         | `haiku`           | `claude-haiku-4-5-20251001` (out=927), **`claude-opus-5[1m]` (out=19)** | **opus — the agent's declaration won** |
| C                 | `inherit`      | `haiku`           | `claude-haiku-4-5-20251001` only (out=1688)                             | haiku — inherited                      |
| D                 | _omitted_      | `haiku`           | `claude-haiku-4-5-20251001` only (out=1354)                             | haiku — inherited                      |

`CONFIRMED`: **an agent's `model:` overrides the session `--model`**, and **`inherit` is behaviourally identical to omitting the key**. In all three runs `subagent_stats.spawned = 1`, `completed = 1`, `by_type.dbprobe = 1`.

### Case B — does session effort reach the subagent?

Agent fixed at `model: opus`; identical arithmetic prompt; only the session `--effort` varied. Metric: the opus entry's `thinkingTokens` in `result.modelUsage`.

| Session `--effort` | Sample 1 | Sample 2 |
| ------------------ | -------- | -------- |
| `low`              | 78       | 77       |
| `max`              | 148      | 262      |

Non-overlapping, directionally consistent. `LIKELY` (n=2, stochastic metric): **the session `--effort` propagates to a subagent that has its own explicit `model:`**.

### Agents can also declare effort

Not in `claude --help`, and not in Dotbabel's `schemas/agent.schema.json`, but accepted:

| Agent `effort` (no session `--effort`) | opus `thinkingTokens` |
| -------------------------------------- | --------------------- |
| `low`                                  | 53                    |
| `max`                                  | 130                   |

`LIKELY`: an agent-level `effort` key is honoured. Dotbabel's agent schema has no `effort` property at all, so 24 agents currently cannot express something the runtime supports.

### Precedence, derived

```
MODEL
  command frontmatter `model:`            ← strongest: replaces the session model at init,
      │                                     for the whole session
      ▼
  agent frontmatter `model:`              ← overrides --model for that subagent's turns
      │                                     (`inherit` / omitted → fall through)
      ▼
  session `--model <alias|full>`          ← sets system/init.model
      │
      ▼
  account default
      │
      ▼
  EFFECTIVE MODEL  → observable as system/init.model and result.modelUsage keys
                     (alias → concrete → canonical: opus → claude-opus-5[1m] → …;
                      haiku → claude-haiku-4-5-20251001 → canonicalModel claude-haiku-4-5)

  skill frontmatter `model:`  ── NOT IN THIS CHAIN AT ALL (measured inert)

EFFORT
  agent frontmatter `effort`               ← honoured (LIKELY)
      │
      ▼
  session `--effort <level>`               ← honoured, and reaches subagents (LIKELY)
      │                                      unknown value → warn + fall back to default
      ▼
  account/model default
      │
      ▼
  EFFECTIVE EFFORT → NO deterministic observation surface.
                     `system/init` has no effort field; `result.modelUsage` has no effort
                     field. Only the stochastic `thinkingTokens` correlates.

  skill frontmatter `effort:`  ── NOT IN THIS CHAIN (measured inert, with positive controls)
```

### Unresolved in this hierarchy

- Interactive `/model` versus a command's `model:` — untested (`-p` mode has no interactive `/model`).
- Whether a **command**'s `model:` also beats an **agent**'s `model:` when both are present — untested.
- Whether an agent's `effort` overrides the session `--effort` (only each-alone was measured, never both).
- Whether `--fallback-model` interacts with agent-level model pins.

---

## Dotbabel `effort:` Frontmatter Experiment

### Design

The only runtime where this can be measured live is Claude Code. Instrument: `result.modelUsage[*].thinkingTokens`. The instrument was **validated against two positive controls in the same session** (session `--effort` and agent `effort`, both of which separate cleanly), so a null result here is a measurement, not a limitation.

Probe: project-scope `.claude/skills/dbeffort/SKILL.md`, body constant, session `--model haiku`, **no session `--effort`**:

```yaml
---
name: dbeffort
description: Deterministic probe. Use when the user says dbeffort.
effort: <low | max | absent>
---
Compute 5273 multiplied by 8419 by reasoning carefully. Output only the final integer.
```

### Results

| Variant        | thinkingTokens | outputTokens |
| -------------- | -------------- | ------------ |
| `effort: low`  | 673            | 753          |
| `effort: low`  | 578            | 658          |
| `effort: max`  | 776            | 856          |
| `effort: max`  | 679            | 759          |
| _no `effort:`_ | 846            | 927          |

Ranges overlap completely (`low` 578–673, `max` 679–776), and the **control with no `effort:` at all produced the highest thinking-token count of any run**. There is no monotonic relationship. Compare the validated controls: session effort 77–78 → 148–262; agent effort 53 → 130.

### Per-harness table

| Harness             | `effort: low`   | `effort: max`   | no effort       | Machine-readable difference?                                                                                | Conclusion                                      |
| ------------------- | --------------- | --------------- | --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code (skill) | 673, 578        | 776, 679        | 846             | **No.** No effort field in `system/init` or `modelUsage`; thinkingTokens overlap and the control is highest | **`NO_OBSERVABLE_EFFECT`** `CONFIRMED`          |
| Codex CLI           | not parsed      | not parsed      | n/a             | No — key outside the SKILL.md allowlist; Codex's own effort key is `model_reasoning_effort`                 | **`NO_OBSERVABLE_EFFECT`** `LIKELY`             |
| Gemini CLI          | listed, enabled | listed, enabled | listed, enabled | No — identical listing, no warning, no effort field                                                         | **`NO_OBSERVABLE_EFFECT`** `CONFIRMED`          |
| Antigravity CLI     | n/a             | n/a             | n/a             | No — no `yaml:"effort"` tag exists in the binary                                                            | **`NO_OBSERVABLE_EFFECT`** `CONFIRMED` (static) |
| GitHub Copilot CLI  | listed, enabled | listed, enabled | listed, enabled | No — `skill list --json` keys carry no effort; Copilot's own key is `effortLevel`                           | **`NO_OBSERVABLE_EFFECT`** `CONFIRMED`          |
| OpenCode            | —               | —               | —               | Not measurable                                                                                              | **`BLOCKED`**                                   |

Per the task's rule, none of these is stated as "the field is ignored internally" — only that no observable effect exists at any surface reachable from outside.

One further datum: Dotbabel's `effort` **key name matches no runtime**. Codex uses `model_reasoning_effort`, Copilot uses `effortLevel` (config) / `--effort` (flag), Antigravity uses `--effort` (flag only), Gemini uses `thinkingLevel` internally, Claude Code uses `--effort` (flag) and an `effort` key on agents.

---

## Model Discovery

### Claude Code

```
Discovery mechanism:                  none for availability. Active model only, via
                                      `--output-format stream-json`: system/init.model,
                                      result.modelUsage{canonicalModel, provider,
                                      contextWindow, maxOutputTokens, thinkingTokens}
Discovery completeness:               zero available-model enumeration; full active-model detail
Requires network:                     yes (it is a side effect of running a turn)
Account scoped:                       yes
Machine readable:                     yes, JSON-lines
Safe for Dotbabel to invoke automatically:  NO — observing the active model costs a model call
```

`CONFIRMED`: `grep -niE "list.*model|model.*list"` over `claude --help` returns nothing. The only enumeration anywhere is the alias examples in the `--model` help text (`'fable'`, `'opus'`, `'sonnet'`) — which alone confirms `fable` is a current alias absent from Dotbabel's four-value enum.

### Codex CLI

```
Discovery mechanism:                  `codex debug models` → JSON catalog (11 models)
                                      `codex doctor --json` → resolved config view
                                      `codex exec` startup banner → resolved model/provider/effort
Discovery completeness:               per-model default_reasoning_level,
                                      supported_reasoning_levels[{effort,description}],
                                      context_window, max_context_window, support_verbosity,
                                      default_verbosity, visibility, multi_agent_version,
                                      multi_agent_reasoning_effort, and ~28 further fields
Requires network:                     NO — identical 518257-byte output with HTTPS_PROXY pointed
                                      at a dead port; the catalog is bundled
Account scoped:                       NO — full catalog with zero credentials
Machine readable:                     yes, single JSON object {models: [...]}
Safe for Dotbabel to invoke automatically:  YES — read-only, offline, deterministic, no auth, exit 0
```

Determinism: `sha256` of stdout identical across 3 runs (`44b4b18ae234973c`). `CONFIRMED`.

The resolved-config banner is equally valuable and equally free:

```
workdir: $ISO/work
model: gpt-6-astra
provider: openai
approval: never
sandbox: read-only
reasoning effort: none
reasoning summaries: none
```

It appears **before** any network attempt (the run then failed with `401 Unauthorized` on `wss://api.openai.com/v1/responses`), so Codex can report its resolved model, provider, and effort with no credentials at all. `CONFIRMED`.

### Gemini CLI

```
Discovery mechanism:                  none exposed. Bundle contains `listModels` (36 refs) and
                                      `/v1beta/models` (2 refs) but no subcommand reaches them.
                                      Static constants only:
                                        DEFAULT_GEMINI_MODEL       = "gemini-2.5-pro"
                                        DEFAULT_GEMINI_FLASH_MODEL = "gemini-2.5-flash"
                                        DEFAULT_GEMINI_FLASH_LITE_MODEL = "gemini-3.1-flash-lite"
                                        DEFAULT_GEMINI_EMBEDDING_MODEL  = "gemini-embedding-001"
                                        DEFAULT_GEMINI_MODEL_AUTO  = "auto-gemini-2.5"
Discovery completeness:               none — scattered defaults, not a catalog
Requires network:                     n/a
Account scoped:                       n/a
Machine readable:                     no
Safe for Dotbabel to invoke automatically:  n/a — nothing to invoke
```

### Antigravity CLI

```
Discovery mechanism:                  `agy models` → TSV on stdout, banner on stderr
Discovery completeness:               id + human label only. No effort field, no context window,
                                      no provider field, no capability metadata
Requires network:                     yes — stderr says "Fetching available models..."
Account scoped:                       yes (fetched); unverifiable without a second account
Machine readable:                     tab-separated text; no --json (rejected, exit 1)
Safe for Dotbabel to invoke automatically:  with care — stable and cheap, but network-dependent
                                      and the ID grammar is not safely decomposable
```

### GitHub Copilot CLI

```
Discovery mechanism:                  `copilot help config` enumerates the `model` value set
                                      (26 ids); `copilot providers` / `copilot help providers`
                                      documents BYOK; `/model` is interactive only
Discovery completeness:               ids only in help text; no per-model effort or context data.
                                      contextTier exists as a concept ("default", "long_context")
                                      but eligible models are not enumerated
Requires network:                     no (help text is local)
Account scoped:                       the help list is static; actual entitlement is not
                                      (config help notes "Hides preview model names and quota
                                      details", implying per-account visibility)
Machine readable:                     no — indented human help text
Safe for Dotbabel to invoke automatically:  yes to run, but only HUMAN_TEXT to parse
```

The 26 ids: `claude-sonnet-5, claude-fable-5.1, claude-fable-5, claude-opus-5, claude-opus-4.8, claude-opus-4.8-fast, claude-opus-4.7, claude-sonnet-4.6, claude-haiku-4.5, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5-mini, mai-code-1.1-flash, mai-code-1-flash-picker, gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, grok-4.5, kimi-k3, kimi-k2.7-code`.

### OpenCode

```
Discovery mechanism:                  `opencode models` → newline-separated provider/model
                                      `opencode debug config` → JSON of config sources, including
                                        declared providers and their models with limit.context /
                                        limit.output
                                      `opencode debug agents` → JSON agent list (model undefined)
Discovery completeness:               list gives ids only; variants (`#variant`, accepted by
                                      `run --model provider/model#variant`) are NOT enumerated;
                                      declared local providers carry context/output limits
Requires network:                     yes for the hosted list; the background service must be warm
Account scoped:                       YES and config scoped — an isolated config root returns
                                      ZERO models (exit 0)
Machine readable:                     list = text; debug config = JSON
Safe for Dotbabel to invoke automatically:  NOT without a defensive adapter — see below
```

---

## `agy models` Grammar and Stability

Version `1.2.5`. Command: `agy models`. Three consecutive runs from the real config.

| Property                | Observation                                                                               | Class       |
| ----------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| Exit code               | `0` all three runs                                                                        | `CONFIRMED` |
| stdout                  | 14 lines, `id<TAB>label`                                                                  | `CONFIRMED` |
| stderr                  | exactly one line: `Fetching available models...`                                          | `CONFIRMED` |
| **Stream separation**   | **the banner is on stderr; stdout is clean**                                              | `CONFIRMED` |
| Byte-stability          | stdout sha256 identical across 3 runs (`b1cc01131043…`); stderr identical too             | `CONFIRMED` |
| Delimiter               | single TAB (verified with `cat -T` → `^I`)                                                | `CONFIRMED` |
| Labels                  | separate second field, human-formatted with parenthesised qualifier                       | `CONFIRMED` |
| Duplicates              | none (14 lines, 14 unique)                                                                | `CONFIRMED` |
| Ordering                | newest-family-first, then within family high→medium→low; **not** lexicographic            | `CONFIRMED` |
| Machine-readable option | none. `--json` and `--output-format=json` both rejected → usage to stderr, **exit 1**     | `CONFIRMED` |
| Help                    | `agy models --help` → 97 bytes on **stderr**, exit 0; flags are only `-h`/`--help`        | `CONFIRMED` |
| Network                 | required (`Fetching available models...`); offline behaviour not tested non-destructively | `UNCERTAIN` |

Full listing (14 rows), which is small enough to quote in full:

```
gemini-3.8-flash-high      Gemini 3.8 Flash (High)
gemini-3.8-flash-medium    Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low       Gemini 3.8 Flash (Low)
gemini-3.7-flash-high      Gemini 3.7 Flash (High)
gemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low       Gemini 3.7 Flash (Low)
gemini-3.6-flash-high      Gemini 3.6 Flash (High)
gemini-3.6-flash-medium    Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low       Gemini 3.6 Flash (Low)
gemini-3.1-pro-high        Gemini 3.1 Pro (High)
gemini-3.1-pro-low         Gemini 3.1 Pro (Low)
claude-sonnet-4-6          Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium        GPT-OSS 120B (Medium)
```

### Is effort encoded in the IDs? — verified, not assumed

The suffix slot is **not** a uniform effort field:

| ID                                   | Suffix      | Note                               |
| ------------------------------------ | ----------- | ---------------------------------- |
| `gemini-3.8-flash-{high,medium,low}` | effort word | complete triplet                   |
| `gemini-3.1-pro-{high,low}`          | effort word | **no `medium` sibling**            |
| `gpt-oss-120b-medium`                | effort word | **no `high`/`low` siblings**       |
| `claude-opus-4-6-thinking`           | `thinking`  | a non-effort word in the same slot |
| `claude-sonnet-4-6`                  | **none**    | yet the label says `(Thinking)`    |

So splitting on the last hyphen segment would mis-parse 3 of 14 rows. The CLI's own internal representation confirms the suffix is a rendered selector rather than a field: the binary carries `json:"effortSelector"` and `json:"effortByBase,omitempty"` — effort keyed **by base model**. `CONFIRMED`.

Provider cannot be inferred safely either: `gemini-*`, `claude-*`, and `gpt-oss-*` in one list are name-prefix conventions, not a declared provider field, and the task's own rule forbids inferring provider from a model name.

### Parser suitability: `PARSE_WITH_DEFENSIVE_ADAPTER`

Reasons: stdout is clean TSV, deterministic, duplicate-free, and exit-code-honest — all favourable. But there is no machine-readable mode, unknown flags are rejected rather than ignored, help goes to stderr, the ID grammar is not decomposable, ordering is semantic rather than sorted, and the list is fetched over the network so the failure mode is untested. An adapter must treat each row as an **opaque identifier plus a display label**, never derive effort or provider from the string, and must not assume a non-empty list.

---

## `opencode models` Grammar and Stability

Version `v2.0.5`.

| Property                | Observation                                                                                  | Class       |
| ----------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| Exit code               | `0` in **every** case, including empty output                                                | `CONFIRMED` |
| stdout (warm)           | 9 lines, `provider/model`                                                                    | `CONFIRMED` |
| stdout (cold)           | **0 lines** — observed twice (isolated run; first real run)                                  | `CONFIRMED` |
| stdout (`--standalone`) | **0 lines**, even against the real config, twice                                             | `CONFIRMED` |
| stderr                  | empty in all cases                                                                           | `CONFIRMED` |
| Byte-stability (warm)   | sha256 identical across 6 consecutive runs (`8c27bea4d060`)                                  | `CONFIRMED` |
| Cross-time stability    | 8 lines earlier today, 9 lines now — `local-qwen/qwen3-coder-30b-a3b` appeared/disappeared   | `CONFIRMED` |
| Delimiter               | `/` between provider and model; exactly one slash per line                                   | `CONFIRMED` |
| Provider prefix         | mandatory on every row                                                                       | `CONFIRMED` |
| Local providers         | yes — `local-qwen/...`, declared in the user's `opencode.json`                               | `CONFIRMED` |
| Config dependence       | isolated config root → 0 models; declared providers drive the list                           | `CONFIRMED` |
| Ordering                | lexicographically sorted (verified `cmp` against `sort`)                                     | `CONFIRMED` |
| Duplicates              | none (9 lines, 9 unique)                                                                     | `CONFIRMED` |
| Variants                | `run --model` accepts `provider/model#variant`; **no `#` appears in any listed row**         | `CONFIRMED` |
| Machine-readable option | none on `models`. `run --format json` exists; `debug config` emits JSON                      | `CONFIRMED` |
| Refresh option          | none documented; flags are `--standalone`, `--server`, plus globals                          | `CONFIRMED` |
| Cached vs live          | the background service holds the state; `--standalone` spawns a private server that had none | `LIKELY`    |

Representative rows (9 total):

```
local-qwen/qwen3-coder-30b-a3b
opencode/big-pickle
opencode/ling-3.0-flash-fin-free
...
opencode/union-alpha
```

`opencode debug config` returns JSON config sources, including the declared local provider with per-model limits:

```json
{
  "type": "document",
  "path": "$HOME/.config/opencode/opencode.json",
  "info": {
    "providers": {
      "local-qwen": {
        "name": "llama-server (local Qwen3-Coder)",
        "package": "aisdk:@ai-sdk/openai-compatible",
        "settings": { "baseURL": "http://127.0.0.1:<port>/v1" },
        "models": {
          "qwen3-coder-30b-a3b": {
            "name": "Qwen3-Coder-30B-A3B (local)",
            "limit": { "context": 32768, "output": 8192 }
          }
        }
      }
    }
  }
}
```

### Parser suitability: `PARSE_WITH_DEFENSIVE_ADAPTER`

Reasons: the warm-path grammar is trivially parseable, sorted, duplicate-free, and byte-stable. But **exit 0 with empty stdout is a real and reproducible state**, so the exit code cannot be used as a success signal; `--standalone` — the flag that looks like the isolation-friendly choice — reliably produces the empty state; the list changes over time as local providers come and go; and variants are reachable via `--model` yet absent from the listing, so the enumeration is knowingly incomplete. An adapter must treat an empty list as `unavailable`, never as "no models", and must pair the text list with `debug config` to recover declared-provider metadata.

---

## Runtime vs Model Vendor Evidence

Representative, not exhaustive. Each row is a directly observed record.

| Runtime            | Provider/vendor                                                                                                                                        | Model id as the runtime states it                                                               | Effort representation                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Claude Code        | `provider: "firstParty"` (explicit field in `result.modelUsage`)                                                                                       | `claude-opus-5[1m]`, `canonicalModel: claude-opus-5`                                            | separate `--effort` / agent `effort`; no effort field in any output record      |
| Claude Code        | `firstParty`                                                                                                                                           | `claude-haiku-4-5-20251001`, `canonicalModel: claude-haiku-4-5`                                 | same                                                                            |
| Codex CLI          | `model provider: "openai"` (separate resolved field; the catalog has **no** provider field)                                                            | `gpt-6-astra`                                                                                   | `supported_reasoning_levels: [{effort:"low",…},…,{effort:"ultra",…}]` per model |
| Codex CLI          | `openai`                                                                                                                                               | `gpt-5.5`                                                                                       | same field, **but only `low/medium/high/xhigh`**                                |
| Codex CLI          | `model_provider` configurable to `ollama` while `model` stays `<default>`                                                                              | `<default>`                                                                                     | unchanged by the provider switch                                                |
| Antigravity CLI    | not declared anywhere; inferable only from the id prefix                                                                                               | `gemini-3.8-flash-high`                                                                         | **fused into the id**; internally `effortByBase` / `effortSelector`             |
| Antigravity CLI    | not declared                                                                                                                                           | `claude-sonnet-4-6` (label `(Thinking)`)                                                        | **no suffix at all** despite a thinking label                                   |
| Antigravity CLI    | not declared                                                                                                                                           | `gpt-oss-120b-medium`                                                                           | fused, single variant                                                           |
| GitHub Copilot CLI | routed; BYOK types are `openai` \| `azure` \| `anthropic`; `PROVIDER_MODEL_ID` and `PROVIDER_WIRE_MODEL` are **two distinct identities for one model** | `claude-opus-5`, `gpt-5.6-sol`, `gemini-3.8-flash`, `grok-4.5`, `kimi-k3`, `mai-code-1.1-flash` | separate `effortLevel`, plus a third axis `contextTier`                         |
| OpenCode           | provider is **part of the identifier**                                                                                                                 | `opencode/union-alpha`, `local-qwen/qwen3-coder-30b-a3b`                                        | none exposed; `#variant` is a third id component                                |
| Gemini CLI         | single-vendor                                                                                                                                          | `gemini-2.5-pro`, `auto-gemini-2.5`                                                             | internal `thinkingLevel` / `thinkingBudget`; not user-facing                    |

The decisive rows are Antigravity's and Copilot's: **one runtime, six vendors** in Copilot's case (Anthropic, OpenAI, Google, Microsoft, xAI, Moonshot) and three in Antigravity's. Runtime identity carries no information about vendor.

The three id shapes observed are mutually incompatible:

```
Claude Code   claude-opus-5[1m]                  model + context variant in one string
Codex         gpt-6-astra                        plain slug; provider in a sibling config field
Antigravity   gemini-3.8-flash-high              model + effort fused, inconsistently
Copilot       claude-opus-5                      plain slug; effortLevel + contextTier separate
OpenCode      local-qwen/qwen3-coder-30b-a3b     provider/model, plus optional #variant
Gemini        auto-gemini-2.5                    routing mode encoded as a model id
```

---

## Auto / Adaptive / Router Modes

| Runtime            | Native name                                                                                                            | Selects model? | Selects effort?                             | Resulting model inspectable?                                   | Dotbabel could detect it?                    | What it is                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Copilot CLI | **`auto`** as a `--model` value ("use 'auto' to let Copilot pick automatically")                                       | yes            | `UNCERTAIN`                                 | `UNCERTAIN` — `/model` is interactive; live check auth-BLOCKED | yes — a literal `auto` in config/flag        | a **model value** standing for provider-side routing                                                                                                                           |
| GitHub Copilot CLI | automatic switch **into** auto mode on eligible rate-limit errors (`copilot help config`)                              | yes            | `UNCERTAIN`                                 | `UNCERTAIN`                                                    | not from config — it is a runtime transition | an **unresolved routing state** entered on failure                                                                                                                             |
| Gemini CLI         | **`auto-gemini-2.5`** (`DEFAULT_GEMINI_MODEL_AUTO`)                                                                    | yes            | `UNCERTAIN`                                 | `UNCERTAIN`                                                    | yes — a model id with an `auto-` prefix      | a **model id** that denotes routing                                                                                                                                            |
| Codex CLI          | `codex-auto-review` is a catalog entry (`visibility: hide`, `multi_agent_version: v1`); no auto flag                   | task-specific  | it has its own `supported_reasoning_levels` | yes via the catalog                                            | yes                                          | a **purpose-built model**, not a router                                                                                                                                        |
| Claude Code        | `claude auto-mode` (+ `config`/`defaults`/`critique`/`reset`)                                                          | **NO**         | **NO**                                      | n/a                                                            | yes, but irrelevant                          | a **permission classifier**. `auto-mode defaults` keys are `allow, soft_deny, hard_deny, environment`; the serialized config contains **zero** matches for `model` or `effort` |
| Claude Code        | `fast_mode_state` in `system/init` and `result` (observed `"off"`, `fast_mode_disabled_reason: "sdk_opt_in_required"`) | `UNCERTAIN`    | `UNCERTAIN`                                 | the state field is observable                                  | yes — it is in the stream                    | a **session mode** with an explicit state machine                                                                                                                              |
| Antigravity CLI    | none found                                                                                                             | —              | —                                           | —                                                              | —                                            | —                                                                                                                                                                              |
| OpenCode           | none found                                                                                                             | —              | —                                           | —                                                              | —                                            | —                                                                                                                                                                              |

The load-bearing observation is that "auto" is not one concept. It is a **model value** (Copilot), a **model id** (Gemini), a **failure-induced runtime state** (Copilot), a **purpose-built model** (Codex), and a **permission classifier that merely shares the word** (Claude Code). `CONFIRMED`.

---

## Failure Behaviour

| Runtime                        | Unknown model                                                                                                                                                                                                          | Unsupported/unknown effort                                                                                                                                                                                                                | Valid model + invalid effort          | Model unavailable to account                                                      | Model-list failure                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Claude Code                    | **synchronous validation error.** `exit 1`, `[claude-code:unrecognized_model] {"model":"dotbabel-nonexistent-model","query_source":"sdk"}`                                                                             | **warn + silent fallback.** `exit 0`: "Warning: Unknown --effort value '…' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max."                                                                      | accepted; effort warning only         | not tested (`BLOCKED`)                                                            | n/a — no list command                                                      |
| Claude Code — **agent-scoped** | **non-fatal runtime error.** `[claude-code:unrecognized_model] {"model":"…","query_source":"agent:custom:dbp"}` on the stream, but `is_error: false`, `exit 0`, session reports success. Subagent silently did not run | agent `effort` unknown value not tested                                                                                                                                                                                                   | —                                     | —                                                                                 | —                                                                          |
| Codex CLI                      | **ignored metadata → deferred to API.** `-c model=dotbabel-nonexistent-model` propagates verbatim into `doctor --json` and the exec banner; failure would surface only at the API                                      | **accepted verbatim.** Banner shows `reasoning effort: dotbabel-nonexistent-effort`. Typed as a free string, not an enum                                                                                                                  | both accepted; neither validated      | not tested (`BLOCKED`)                                                            | n/a — catalog is bundled and offline                                       |
| Codex CLI — contrast           | —                                                                                                                                                                                                                      | a _sibling_ key **is** enum-validated: `-c model_verbosity="dotbabel-bogus"` → `exit 1`, "unknown variant `dotbabel-bogus`, expected one of `low`, `medium`, `high`"                                                                      | —                                     | —                                                                                 | —                                                                          |
| Codex CLI — unknown config key | `--strict-config -c dotbabel_fake_key=1` → `exit 1`, "Error loading config.toml: unknown configuration field `dotbabel_fake_key` in -c/--config override", **before auth**                                             | `--strict-config -c model_reasoning_effort=high` → no error ⇒ the key **is** recognized                                                                                                                                                   | —                                     | —                                                                                 | —                                                                          |
| Codex CLI — type check         | `-c model_reasoning_effort=123` → `exit 1`, "invalid type: integer `123`, expected a string in `model_reasoning_effort`"                                                                                               | —                                                                                                                                                                                                                                         | —                                     | —                                                                                 | —                                                                          |
| Gemini CLI                     | **no client-side validation.** `-m dotbabel-nonexistent-model -p x` → `exit 41` with an auth message identical to the no-flag run                                                                                      | no effort flag exists                                                                                                                                                                                                                     | —                                     | not tested (`BLOCKED`)                                                            | n/a                                                                        |
| Antigravity CLI                | **no client-side validation.** `--model dotbabel-nonexistent-model --print x` reaches interactive OAuth                                                                                                                | **no client-side validation.** `--effort dotbabel-nonexistent-effort` also reaches OAuth, despite the documented `low\|medium\|high`                                                                                                      | —                                     | `BLOCKED`                                                                         | `agy models --json` → `exit 1` + usage on stderr (unknown _flag_ rejected) |
| GitHub Copilot CLI             | **no client-side validation.** `--model dotbabel-nonexistent-model` → `exit 1` "No authentication information found" — the same error as with a valid model                                                            | **synchronous parser rejection.** `exit 1`: "error: option `--effort, --reasoning-effort <level>` argument 'dotbabel-nonexistent-effort' is invalid. Allowed choices are none, minimal, low, medium, high, xhigh, max." — **before auth** | model accepted, effort rejected first | `UNCERTAIN` — config help mentions per-model rate limits and hidden preview names | n/a                                                                        |
| OpenCode                       | `BLOCKED`                                                                                                                                                                                                              | no effort flag                                                                                                                                                                                                                            | —                                     | `BLOCKED`                                                                         | **silent empty success.** `exit 0`, empty stdout, empty stderr             |

Two patterns matter for resolver safety:

- **Model and effort are validated by opposite disciplines, inconsistently across runtimes.** Effort is a closed enum at the parser in Copilot, a warn-and-default in Claude Code, and an unvalidated free string in Codex. Model is synchronously validated only in Claude Code and unvalidated everywhere else.
- **Two silent-failure modes exist.** A Claude subagent with an unknown model fails while the session reports success; `opencode models` reports success while returning nothing.

---

## Discovery Suitability

| Runtime            | Availability discovery         | Effort discovery                                                                   | Active-model observation                                                                                                           | Suitable for automatic Dotbabel probing? | Why                                                                                                                         |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | **NONE**                       | **NONE** (no enumeration; the valid set is only revealed in a warning message)     | **yes, rich** — `system/init.model`, `result.modelUsage{canonicalModel, provider, contextWindow, maxOutputTokens, thinkingTokens}` | **no**                                   | Observation requires running a billable turn. There is no read-only path.                                                   |
| Codex CLI          | **STRUCTURED**                 | **STRUCTURED, per model**                                                          | **yes, free** — `doctor --json` resolved config and the `exec` banner, both pre-auth                                               | **yes**                                  | `codex debug models` is offline, deterministic (identical sha256 ×3), credential-free, exit 0. The best surface of the six. |
| Gemini CLI         | **NONE**                       | **NONE**                                                                           | no                                                                                                                                 | **no**                                   | Nothing to invoke. Only static bundle constants.                                                                            |
| Antigravity CLI    | **PARSEABLE_TEXT**             | **fused into ids, not separately discoverable**                                    | no                                                                                                                                 | **with care**                            | Stable TSV, clean streams, but network-dependent, no JSON, and ids are not decomposable.                                    |
| GitHub Copilot CLI | **HUMAN_TEXT**                 | **HUMAN_TEXT** (the 7-value enum appears in `--help` and in the rejection message) | no read-only path found                                                                                                            | **partially**                            | `copilot skill list --json` is genuinely structured and auth-free; the _model_ list is indented help prose.                 |
| OpenCode           | **PARSEABLE_TEXT**, incomplete | **NONE**                                                                           | no                                                                                                                                 | **not without a defensive adapter**      | Exit 0 with empty output is reproducible; `--standalone` reliably empty; variants unenumerated.                             |

---

## Confirmed Constraints for Future Design

Each constraint names the experiment that establishes it. No architecture is proposed.

1. **A future schema MUST NOT put `model:` on a skill and expect any runtime to honour it.** The Claude-skill experiment shows `model: opus` inert in a haiku session (`modelUsage` = haiku only), and Gemini and Copilot list identical entries for all five variants with no model field anywhere in their output.

2. **A future schema MUST distinguish agent, command, and skill as three different model-binding scopes.** In Claude Code a command's `model:` replaces the session model at `system/init`, an agent's `model:` overrides `--model` for its own turns only, and a skill's `model:` does nothing. One `model:` key cannot mean all three.

3. **A future schema MUST NOT treat effort as a model-independent axis.** `codex debug models` shows `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.2` supporting only `low/medium/high/xhigh`, while `gpt-6-astra` and `gpt-5.6-sol` also support `max` and `ultra`. Effort validity is a function of the model.

4. **A future schema MUST NOT assume `(model, effort)` are separable in a runtime's identifier space.** `agy models` returns `gemini-3.8-flash-high` with no separate effort field, and the suffix slot is occupied by `-thinking` for one model and empty for another whose label still says `(Thinking)`.

5. **A future schema MUST NOT derive provider from runtime identity.** Copilot's own config help enumerates 26 models spanning six vendors; `agy models` lists `gemini-*`, `claude-*`, and `gpt-oss-*` together.

6. **A future schema MUST NOT derive provider from a model id either.** Codex exposes `model_provider` as a _separate resolved field_ (switchable to `ollama` while `model` stays `<default>`), and its model catalog contains **no** provider field at all.

7. **A future model identifier MUST be treated as opaque.** Observed shapes include an embedded context variant (`claude-opus-5[1m]`), a fused effort suffix (`gemini-3.8-flash-high`), a mandatory provider prefix (`local-qwen/...`), an optional third component (`provider/model#variant`), and a routing sentinel (`auto-gemini-2.5`).

8. **A future model must be able to express more than two axes.** Copilot's `subagents.agents.<name>` carries **`model`, `effortLevel`, and `contextTier`**, and Codex adds `model_verbosity`, `model_context_window`, and `multi_agent_reasoning_effort`.

9. **A future schema MUST have an explicit `inherit` sentinel for every axis, and MUST NOT conflate "absent" with "inherit" silently — even though Claude Code does.** Claude Code's `inherit` and omitted behave identically (both fell through to the session model), while Copilot documents `"inherit"` as an explicit per-field value for all three of its axes. The two conventions must be representable separately.

10. **A future resolver MUST NOT rely on an exit code to mean "this list is valid".** `opencode models` returns exit 0 with zero lines on a cold start and under `--standalone`, reproducibly.

11. **A future resolver MUST have an `unavailable` state distinct from "empty".** OpenCode's model list is config-scoped: an isolated config root yields zero models, and the `local-qwen` entry appeared and disappeared between two runs hours apart.

12. **A future resolver MUST NOT assume a model or effort value it emits will be validated by the runtime.** Codex accepted `dotbabel-nonexistent-model` and `dotbabel-nonexistent-effort` verbatim into resolved config; Gemini, Antigravity, and Copilot reach auth before validating a model.

13. **A future resolver MUST treat effort-value validation as per-runtime and non-uniform.** Copilot rejects an unknown effort at the arg parser (exit 1), Claude Code warns and falls back (exit 0), Codex accepts any string — while enum-validating the sibling key `model_verbosity`.

14. **A future resolver MUST NOT emit a per-agent model pin without a failure path, because one runtime fails it silently.** A Claude subagent with an unrecognised model produced `query_source: "agent:custom:dbp"` on the stream while the session returned `is_error: false` and exit 0.

15. **A future capability store MUST be version-stamped and MUST expect invalidation within hours.** `agy` moved 1.2.4 → 1.2.5 during this investigation (binary mtime `2026-09-17 12:31`); `agents.mjs:272,279` pins facts to "agy v1.2.4" in prose comments.

16. **A future schema MUST NOT reuse the word "auto" as a single concept.** It is a model value in Copilot, a model id in Gemini, a failure-induced state in Copilot, a purpose-built model in Codex, and a permission classifier in Claude Code.

17. **A future design MUST NOT reuse the word "provider" for model vendors in this repository.** `opencode debug config` uses `providers` for model vendors, while Dotbabel's existing skills use "Provider" for cloud vendors (`skills/rollback-prod`, `skills/deploy-status`). The collision is now live in both directions.

18. **Any per-harness translation layer MUST cover `.claude/skills/` and `.agents/skills/` as Copilot inputs.** `copilot skill list --json` discovered probes in both with `source: "project"`, so Copilot bypasses the `copilot-frontmatter.mjs` stripping entirely via trees Dotbabel writes for other runtimes.

19. **Effort has no deterministic observation surface on the runtime Dotbabel targets most.** Claude Code's `system/init` and `result.modelUsage` contain no effort field; only stochastic `thinkingTokens` correlates. A resolver cannot verify that an effort setting took hold.

20. **Dotbabel's `effort` key name matches no runtime's key name.** Codex: `model_reasoning_effort`. Copilot: `effortLevel` / `--effort`. Antigravity: `--effort` flag only, no YAML field. Gemini: `thinkingLevel`, internal. Claude Code: `--effort` flag and an agent-level `effort` key.

---

## Corrections to `model-selection-audit.md`

Stated explicitly rather than silently rewritten.

| #   | Audit claim                                                                                                                                    | Correction                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | Harness Analysis → Codex: "**Models?** No." and the capability table row "Model discovery: no"                                                 | **Wrong.** Codex has the best model discovery of all six: `codex debug models` → structured JSON, 11 models, per-model effort support, offline, deterministic, credential-free. Also `codex doctor --json` and the `exec` banner expose resolved model/provider/effort.                                      | `codex debug models` (518257 B, sha `44b4b18ae234973c` ×3, identical with the network blocked)            |
| 2   | Unknown #4: "Does Codex CLI 0.154.0 expose a reasoning-effort setting? `UNCERTAIN`"                                                            | **Resolved: yes.** `model_reasoning_effort` is a recognized config key, and the catalog carries `default_reasoning_level` + `supported_reasoning_levels` per model.                                                                                                                                          | `--strict-config` oracle; catalog fields                                                                  |
| 3   | Unknown #11 / Staleness: "`agy models` prints a 'Fetching available models…' banner **to the same stream**, which a parser must handle"        | **Wrong.** The banner is on **stderr**; stdout is clean TSV.                                                                                                                                                                                                                                                 | 3 runs with streams separated: stdout 14 lines, stderr exactly `Fetching available models...`             |
| 4   | Finding 2 and the Configuration-Inheritance diagram treat skills and commands as one class whose `model:` is "passed through, meaning unknown" | **Sharpened, and materially so.** In Claude Code a command's `model:` **overrides the session model for the whole session**; a skill's `model:` is inert. Dotbabel's 7 commands are live; its 36 skills are not.                                                                                             | command probe → `init.model = claude-opus-5`; skill probe → haiku only                                    |
| 5   | Harness Analysis → Copilot: "Copilot CLI has no skill auto-discovery dir" (quoting `agents.mjs:226-228`) and `globalSkills: null`              | **Wrong for 1.0.83.** Copilot discovers `.github/skills/`, `.agents/skills/`, `.claude/skills/` (project) and `~/.copilot/skills/`, `~/.agents/skills/` (personal). It is therefore already reading two trees Dotbabel writes, with frontmatter unstripped.                                                  | `copilot skill list --json`: `dbproj-claude` and `dbproj-agents`, both `source: project`, `enabled: true` |
| 6   | Runtime versions: "Antigravity CLI `1.2.4`"                                                                                                    | **Superseded within the day.** Now `1.2.5`; binary mtime `2026-09-17 12:31`.                                                                                                                                                                                                                                 | `agy --version` ×3                                                                                        |
| 7   | Harness Analysis → OpenCode: "`opencode models` returns provider-prefixed ids" (treated as reliable)                                           | **Incomplete.** Correct when warm, but the command returns **0 lines with exit 0** on a cold start and under `--standalone`, and the list is config-scoped (0 models in an isolated root).                                                                                                                   | 11 runs across warm/cold/standalone/isolated                                                              |
| 8   | Staleness table: "A provider's tier ladder has exactly 3 rungs + `inherit` … Already live — `fable` is a current Claude alias"                 | **Confirmed and strengthened.** `claude --help` names `'fable'` among `--model` aliases, and Copilot's config enum includes `claude-fable-5.1` and `claude-fable-5`.                                                                                                                                         | `claude --help`; `copilot help config`                                                                    |
| 9   | Gaps → Discovery: "Dotbabel cannot determine supported effort modes" (framed as a Dotbabel-side gap only)                                      | **Sharpened.** It is also a runtime-side gap for three of six: Gemini and OpenCode expose no effort surface at all, and Claude Code exposes its valid set only inside a warning message.                                                                                                                     | help capture ×6; Claude effort-warning text                                                               |
| 10  | Unknown #12: "Do `low`/`medium`/`high` mean comparable things … `LIKELY not`"                                                                  | **Resolved: they do not.** Codex ships per-model human descriptions that differ between models for the same word (`gpt-5.2` "low" = "Balances speed with some reasoning…" vs `gpt-6-astra` "low" = "Fast responses with lighter reasoning"), and the enums themselves differ per runtime (5 / 7 / 3 values). | `codex debug models` `supported_reasoning_levels`                                                         |
| 11  | Risk Analysis and Auto-mode discussion did not mention Claude Code's `auto-mode`                                                               | **Clarified to prevent a false friend.** `claude auto-mode` is a **permission** classifier (`allow`, `soft_deny`, `hard_deny`, `environment`), with zero `model`/`effort` occurrences. It must not be read as model routing.                                                                                 | `claude auto-mode config` / `defaults`                                                                    |
| 12  | Audit assumed Claude agents cannot express effort (no `effort` in `agent.schema.json`, "Effort configuration: **absent**")                     | **Sharpened.** The _schema_ lacks it, but the _runtime_ accepts it: agent-level `effort` low→53 vs max→130 thinking tokens. Dotbabel's 24 agents cannot currently express a capability Claude Code supports.                                                                                                 | inline `--agents` with an `effort` key                                                                    |

Nothing in the previous audit's core thesis is overturned. Findings 1, 2, 4, 5, and 7 are refinements that make the problem more specific; findings 1, 3, 5, 6, and 7 are outright corrections of fact.

---

## Reconciliation of the 13 Unknowns in `model-selection-audit.md`

|   # | Unknown (audit `:1503-1551`)                                                                         | Status                 | Resolution                                                                                                                                                                                                                                                                                 |
| --: | ---------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | What does each non-Claude harness do with an unrecognised `model:` in `SKILL.md`?                    | **PARTIALLY RESOLVED** | Gemini and Copilot: **IGNORED**, discovered and enabled, no warning (`CONFIRMED`). Codex: **LIKELY NOT_PARSED** (allowlist `{name, description, license, allowed-tools, metadata}`). Antigravity: **UNCERTAIN** for model, **CONFIRMED NOT_PARSED** for effort. OpenCode: **BLOCKED**.     |
|   2 | Does Claude Code honour a subagent's `model:` when the session has an explicit `--model`/`--effort`? | **RESOLVED**           | Yes for model — agent `opus` beat session `haiku` (`claude-opus-5[1m]` in `modelUsage`). Session `--effort` additionally propagates to that subagent (78,77 vs 148,262 thinking tokens).                                                                                                   |
|   3 | Is a skill's `tools:` list restrictive or advisory for `Task`/`Agent`?                               | **STILL UNKNOWN**      | One attempt was inconclusive: the `Skill` tool itself was permission-denied before the body ran (`permission_denials: [{tool_name:"Skill"}]`, `subagent spawned: 0`). Tangential to model selection; not pursued further.                                                                  |
|   4 | Does Codex CLI 0.154.0 expose a reasoning-effort setting?                                            | **RESOLVED**           | Yes: `model_reasoning_effort` (recognized via `--strict-config`), surfaced as `reasoning effort:` in the `exec` banner, with per-model `supported_reasoning_levels` in the catalog. Related keys: `model_reasoning_summary`, `model_verbosity`, `model_context_window`.                    |
|   5 | Does OpenCode v2.0.5 expose per-model effort or an effort flag?                                      | **PARTIALLY RESOLVED** | No effort flag (`--thinking` only _shows_ thinking blocks). `run --model provider/model#variant` implies a third id component that may carry variant semantics, but variants are not enumerated by `models`.                                                                               |
|   6 | Does Gemini CLI 0.59.0 expose an effort flag or a model list?                                        | **RESOLVED**           | Neither. `-m/--model` only. Internally `thinkingConfig`/`thinkingBudget`/`thinkingLevel` (e.g. `ThinkingLevel.HIGH`), zero `reasoningEffort`. `listModels` and `/v1beta/models` exist in the bundle but no subcommand exposes them.                                                        |
|   7 | Is the missing `--model` in `templates/workflows/ai-review.yml:27` intentional?                      | **STILL UNKNOWN**      | An owner decision, not an empirical question. New context: Claude Code rejects an unknown `--model` synchronously (exit 1), so an explicit pin would fail fast rather than silently — which makes the choice consequential.                                                                |
|   8 | What were `compliance-auditor`'s and `data-scientist`'s tiers chosen for?                            | **STILL UNKNOWN**      | Owner decision; not recoverable from any runtime.                                                                                                                                                                                                                                          |
|   9 | Which is authoritative for `validate-spec` — `sonnet` or `opus`?                                     | **STILL UNKNOWN**      | Owner decision. New context: since a **skill**'s `model:` is inert in Claude Code, the answer currently has **no runtime effect** either way.                                                                                                                                              |
|  10 | Do the `effort:` values have any observable effect today?                                            | **RESOLVED**           | **No.** `NO_OBSERVABLE_EFFECT`, measured on Claude Code with validated positive controls; not parsed by Antigravity; not surfaced by Gemini or Copilot; LIKELY not parsed by Codex.                                                                                                        |
|  11 | Are `agy models` / `opencode models` outputs stable enough to parse?                                 | **RESOLVED**           | Both `PARSE_WITH_DEFENSIVE_ADAPTER`. `agy models`: deterministic TSV, banner on **stderr** (audit was wrong about this), no JSON, ids not decomposable. `opencode models`: byte-stable when warm, but **exit 0 + empty output** on cold start and under `--standalone`, and config-scoped. |
|  12 | Do `low`/`medium`/`high` mean comparable things across runtimes?                                     | **RESOLVED**           | **No.** Enum sizes differ (Claude 5, Copilot 7, Antigravity 3, Codex per-model); Codex's own per-model descriptions for the same word differ between models; Antigravity fuses them into ids.                                                                                              |
|  13 | Do consumers of the published npm package override the shipped model values?                         | **BLOCKED**            | Not observable from this machine or any runtime surface. Needs consumer telemetry or a survey.                                                                                                                                                                                             |

**Totals: 6 RESOLVED · 2 PARTIALLY RESOLVED · 4 STILL UNKNOWN · 1 BLOCKED.** Of the 4 still unknown, 3 are owner decisions rather than empirical questions, and 1 (#3) is tangential to model selection.

---

## Remaining Unknowns

Genuine unresolved questions only.

1. **OpenCode's skill-frontmatter behaviour.** `BLOCKED`. No read-only skill listing exists, and an isolated config root cannot start the background service. Needs either a disposable configured provider (e.g. a local OpenAI-compatible endpoint declared in an isolated `opencode.json`) or an upstream source read.
2. **Antigravity's skill-frontmatter `model:` behaviour.** `BLOCKED`. Live invocation needs interactive OAuth. The single `yaml:"model,omitempty"` tag in the binary could not be attributed to a struct.
3. **Whether Codex's SKILL.md allowlist runs in the Rust loader or only in the bundled Python authoring tool.** `UNCERTAIN`. Determines whether Dotbabel's `model:`/`effort:` keys are _rejected_ or merely _ignored_ by Codex at load time.
4. **Whether any runtime other than Claude Code can report its active model without consuming a turn.** Codex can (banner + `doctor --json`, both pre-auth) — so the real question is Gemini, Antigravity, Copilot, and OpenCode. `UNCERTAIN`.
5. **Whether Copilot's `--model auto` result is inspectable after the fact.** `UNCERTAIN`, auth-BLOCKED. Decides whether Auto is an observable resolution or a permanently unresolved state.
6. **Whether an agent-level `effort` overrides a session `--effort` in Claude Code.** Each was measured alone; the conflict case was not run.
7. **Whether a command's `model:` beats an agent's `model:`** when both are present in one Claude Code session.
8. **Interactive `/model` precedence** in Claude Code and Copilot. `-p` mode has no interactive path.
9. **Whether `agy models` degrades gracefully offline.** Not tested non-destructively.
10. **Whether OpenCode's `#variant` component carries effort semantics.** `--model provider/model#variant` is documented in help; no variant appears in any listing.
11. **Whether Copilot's `contextTier` eligibility is discoverable.** The concept is documented (`"default"`, `"long_context"`); the eligible model set is not enumerated.
12. **Whether the 13th audit unknown (consumer overrides) can be answered at all** without adding telemetry Dotbabel does not have and may not want.

---

## Evidence Needed Before Model Intelligence Design

**Sufficient evidence now exists to begin data-model design.** The 20 constraints above are all evidence-backed, and they pin down the parts a schema must get right: identifier opacity, per-model effort validity, provider as an independent axis, more than two axes, an explicit inherit sentinel, an `unavailable` state distinct from empty, and scope-specific model binding (agent vs command vs skill).

**Evidence is not yet sufficient to design the discovery/probing layer.** Three blockers:

1. **OpenCode and Antigravity frontmatter behaviour** (unknowns 1–2). Two of six runtimes have no measured answer to the question the whole investigation was built around. Both need a safe live path: for OpenCode, an isolated config declaring a disposable local provider; for Antigravity, an explicit decision from the repository owner about whether a one-time authenticated probe in an isolated `ANTIGRAVITY_CONFIG_HOME` is acceptable.
2. **Active-model observability for four runtimes** (unknown 4). A resolver that cannot read back the effective model cannot verify its own recommendations. Codex and Claude Code are solved; Gemini, Antigravity, Copilot, and OpenCode are not.
3. **Whether Codex rejects or ignores unknown skill frontmatter keys** (unknown 3). Rejection would make Dotbabel's current fan-out actively harmful to Codex users rather than merely inert — a materially different severity.

Two further items are cheap and worth resolving before any resolver is specified, because both change its ordering rules: the Claude Code precedence conflicts (unknowns 6–7) and Copilot's Auto-resolution observability (unknown 5).

One non-technical prerequisite: the four owner decisions from the previous audit (unknowns 7, 8, 9, and the `agents-search` tier ladder) remain open, and #9 is now known to have no runtime effect at all — which may change how the owner wants to answer it.

---

## Reproduction Commands

Every recipe uses `mktemp -d`, sets config roots explicitly, and writes nothing outside the temp root. Run under `bash`, not `zsh`.

### Versions and help, both streams

```bash
for c in claude codex gemini agy copilot opencode; do
  echo "== $c"; timeout 45 "$c" --version; echo "exit=$?"
  timeout 60 "$c" --help >/tmp/h.out 2>/tmp/h.err
  echo "help stdout=$(wc -c </tmp/h.out) stderr=$(wc -c </tmp/h.err)"   # agy writes help to stderr
done
```

### Verify isolation before invoking

```bash
ISO=$(mktemp -d)
env -i PATH="$PATH" HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/xdg" \
  OPENCODE_CONFIG_DIR="$ISO/oc" opencode debug paths     # expect config → $ISO/oc
env -i PATH="$PATH" HOME="$ISO/home" CODEX_HOME="$ISO/ch" \
  codex doctor --json | grep -o '"CODEX_HOME":"[^"]*"'   # expect $ISO/ch
rm -rf "$ISO"
```

### Codex: config-key recognition oracle (no network, no auth)

```bash
ISO=$(mktemp -d); mkdir -p "$ISO/ch" "$ISO/work"; cd "$ISO/work"
for key in model model_provider model_reasoning_effort model_verbosity dotbabel_fake_key; do
  out=$(env -i PATH="$PATH" HOME="$ISO/home" CODEX_HOME="$ISO/ch" \
        codex exec --skip-git-repo-check --strict-config -c "$key=high" x </dev/null 2>&1)
  echo "$key: $(echo "$out" | grep -q 'unknown configuration field' && echo UNKNOWN_KEY || echo RECOGNIZED)"
done
cd /; rm -rf "$ISO"
```

### Codex: resolved-model banner and offline catalog

```bash
ISO=$(mktemp -d); mkdir -p "$ISO/ch" "$ISO/work"; cd "$ISO/work"
env -i PATH="$PATH" HOME="$ISO/home" CODEX_HOME="$ISO/ch" \
  codex exec --skip-git-repo-check -c model_reasoning_effort='"xhigh"' x </dev/null 2>&1 \
  | grep -E '^(model|provider|reasoning effort):'
env -i PATH="$PATH" HOME="$ISO/home" CODEX_HOME="$ISO/ch" \
  HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
  codex debug models | sha256sum      # identical offline; catalog is bundled
cd /; rm -rf "$ISO"
```

### Gemini: skill frontmatter discovery

```bash
ISO=$(mktemp -d); mkdir -p "$ISO/home/.gemini/skills/dbprobe" "$ISO/proj"
printf -- '---\nname: dbprobe\ndescription: Probe. Use when the user says dbprobe.\nmodel: opus\neffort: max\n---\n\nOutput exactly: DOTBABEL_MODEL_PROBE\n' \
  > "$ISO/home/.gemini/skills/dbprobe/SKILL.md"
cd "$ISO/proj"
env -i PATH="$PATH" HOME="$ISO/home" GEMINI_HOME="$ISO/home/.gemini" TERM=dumb \
  gemini skills list --all
cd /; rm -rf "$ISO"
```

### Copilot: skill frontmatter discovery, machine-readable

```bash
ISO=$(mktemp -d); mkdir -p "$ISO/home" "$ISO/ch/skills/dbprobe" "$ISO/proj/.claude/skills/dbproj"
printf -- '---\nname: dbprobe\ndescription: Probe. Use when the user says dbprobe.\nmodel: opus\neffort: max\n---\n\nOutput exactly: DOTBABEL_MODEL_PROBE\n' \
  | tee "$ISO/ch/skills/dbprobe/SKILL.md" \
  | sed 's/dbprobe/dbproj/' > "$ISO/proj/.claude/skills/dbproj/SKILL.md"
cd "$ISO/proj"
env -i PATH="$PATH" HOME="$ISO/home" COPILOT_HOME="$ISO/ch" TERM=dumb \
  copilot skill list --json
cd /; rm -rf "$ISO"
```

### Discovery stability

```bash
for i in 1 2 3; do agy models 2>/dev/null | sha256sum; done       # expect identical
agy models 2>&1 1>/dev/null                                        # banner is on stderr
for i in 1 2 3; do opencode models 2>/dev/null | wc -l; done       # first may be 0 with exit 0
opencode models --standalone | wc -l                               # reproducibly 0
opencode debug config | head -30                                   # JSON config sources
```

### Claude Code: precedence, no files written, no transcript persisted

```bash
T=$(mktemp -d); cd "$T"
AG='{"dbprobe":{"description":"Probe. Use when asked to run dbprobe.","prompt":"Output exactly: DOTBABEL_MODEL_PROBE","model":"opus","tools":["Read"]}}'
claude -p 'Use the Task tool once with subagent_type dbprobe and prompt "run dbprobe". Then reply exactly: DONE' \
  --model haiku --agents "$AG" --allowedTools "Task,Read" \
  --output-format stream-json --verbose --no-session-persistence </dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for(const l of s.trim().split("\n")){try{const j=JSON.parse(l);
        if(j.type==="system"&&j.subtype==="init")console.log("session:",j.model);
        if(j.type==="result")console.log("modelUsage:",Object.keys(j.modelUsage||{}).join(", "));
      }catch(e){}}})'
# expect: session claude-haiku-...  modelUsage includes claude-opus-5[1m]
# swap "model":"opus" for "inherit" or delete the key → only haiku appears
cd /; rm -rf "$T"
```

### Claude Code: the skill-vs-command asymmetry

```bash
T=$(mktemp -d); mkdir -p "$T/.claude/skills/dbskill" "$T/.claude/commands"; cd "$T"
printf -- '---\nname: dbskill\ndescription: Probe. Use when the user says dbskill.\nmodel: opus\neffort: max\n---\n\nOutput exactly: DOTBABEL_MODEL_PROBE\n' > .claude/skills/dbskill/SKILL.md
printf -- '---\ndescription: Probe command.\nmodel: opus\n---\n\nOutput exactly: DOTBABEL_MODEL_PROBE\n' > .claude/commands/dbcmd.md
for p in 'Invoke the dbskill skill now, then reply exactly: DONE' '/dbcmd'; do
  claude -p "$p" --model haiku --allowedTools "Skill,Read" \
    --output-format stream-json --verbose --no-session-persistence </dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        for(const l of s.trim().split("\n")){try{const j=JSON.parse(l);
          if(j.type==="result")console.log("modelUsage:",Object.keys(j.modelUsage||{}).join(", "));
        }catch(e){}}})'
done
# skill  → claude-haiku-...            (model: opus ignored)
# command → claude-opus-5              (model: opus overrides the whole session)
cd /; rm -rf "$T"
```

### Failure behaviour

```bash
claude -p 'Reply with exactly: OK' --no-session-persistence --output-format json \
  --model dotbabel-nonexistent-model           # exit 1, [claude-code:unrecognized_model]
claude -p 'Reply with exactly: OK' --no-session-persistence --output-format json \
  --model haiku --effort dotbabel-nonexistent-effort   # exit 0, warning + default

ISO=$(mktemp -d); mkdir -p "$ISO/home" "$ISO/ch"
env -i PATH="$PATH" HOME="$ISO/home" COPILOT_HOME="$ISO/ch" \
  copilot -p x --effort dotbabel-nonexistent-effort   # exit 1, parser rejects, prints the enum
rm -rf "$ISO"
```

### Not reproducible without credentials or interaction

- Antigravity live invocation (`agy --print`) — opens an interactive Google OAuth flow under an isolated `HOME`.
- Gemini live invocation — needs `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, or `GOOGLE_GENAI_USE_GCA`.
- Copilot live invocation — needs GitHub OAuth or a fine-grained PAT.
- OpenCode live invocation — needs at least one configured provider in the isolated config root.
- Claude Code experiments — reproduce only with the user's own Claude Code credentials; they are **not** credential-isolated, though they write no transcript and touch no file under `~/.claude`.

---

_Investigation performed 2026-09-17 against repository commit `0db0221`. The only repository file created or changed is this one._

> Correction, 2026-09-18: finding 4 first said that 12 skills declare `effort: max`. A recount of the `skills/*/SKILL.md` frontmatter gives 11, with 6 `medium` and 1 `low`. Corrected in place.
