# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

## External APIs

| API                                                              | Use                                                                                                             | When                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `gh` (existing)                                                  | `pr list` and `pr view`, for stacks and pull request dependencies. `issue view` is new, for issue dependencies. | Stacks as today. Dependencies only with `--online` (KD-2).          |
| Jev, `POST https://api.typesafe.ai/v1/systemone` (DOC-7, DOC-11) | A state plus typed questions, answered with typed values                                                        | Only when the repository enables it and the user holds a key (KD-8) |

## Internal APIs

<!-- Endpoints this system exposes -->

### Dependency references (Phase 1)

A `depends_on` entry takes one of three forms (KD-2, KD-4):

| Form                                    | Example                        | Resolved                                                              |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| A task in the same repository           | `<slug>`                       | From the task files of every worktree of the clone, always offline    |
| A task in another clone on this machine | `github.com/owner/repo:<slug>` | From local files, always offline                                      |
| A GitHub pull request or issue          | `owner/repo#123`               | Through `gh`, only with `--online`. Otherwise the state is `unknown`. |

When a reference matches tasks in two clones of one repository, the graph reports it as ambiguous and does not choose a clone (R-8).

**Q-1, resolved by KD-4.** Slugs were unique only within one worktree (`plugins/dotbabel/src/task-state.mjs:15-16`). `dotbabel task new` now refuses a slug that another worktree of the clone uses.

### Task commands (Phase 1)

```text
dotbabel task new <slug> ... [--depends-on <ref>]...
dotbabel task update <slug> [--depends-on <ref>]... [--drop-depends-on <ref>]...
dotbabel task graph [--json] [--online]
dotbabel task next  [--json] [--online]
```

- `task graph` shows every open task of the clone, its edges, a topological order, and any cycle.
- `task next` lists the ready tasks, whose dependencies are all satisfied. It lists the blocked tasks with the references they wait on and the state of each.
- A dependency is satisfied when its task is closed, its pull request is merged, or its issue is closed.
- Offline, a pull request or issue is `unknown`, and `unknown` counts as blocked.
- `task new` and `task update` refuse an edge that closes a cycle inside the clone, with exit 1.
- Exit codes stay as the task CLI defines them: 0 ok, 1 refused, 2 environment error, 64 usage error (`plugins/dotbabel/bin/dotbabel-task.mjs` `USAGE`).

### `dotbabel decide` (Phase 3)

```text
dotbabel decide --step review-triage|retry|dispatch [--base-ref <ref>]
  input:  JSON on stdin
  output: JSON on stdout: {step, answer, confidence, decider, fallback}
```

- `decide()` is the library function behind the CLI (KD-5).
- For the `retry` step, the attempt cap comes from the committed `.dotbabel.json` of a base ref, without a network call. `--base-ref <ref>` names that ref. Without it, the base is `origin/HEAD`, then `origin/main`, then `HEAD`.
- The review skill calls `decide` only for a finding that the fast path does not take (`skills/review-pr/SKILL.md:83-89`).
- When a model adapter fails, the built-in rule answers, and the output has `fallback: true`.
- The run receipt records each answer through `pr-stack record`.

Questions that a model adapter asks per step (DOC-11):

| Step            | Question                                                                       | Use of the answer                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review-triage` | `noul`: "this finding is a real defect"                                        | At or above `hi`: auto-valid. At or below `lo`: auto-false-positive. Between them: the full validation. `hi` and `lo` come from the step's experiment (KD-9). |
| `retry`         | `choice` over `retry`, `fix`, `ask-owner`, given the tail of the failure       | The skill takes the chosen action, inside the attempt cap.                                                                                                    |
| `dispatch`      | `noul` per reviewer not already in the profile: "this diff needs `<reviewer>`" | The reviewer is added when the answer is at or above the step's threshold.                                                                                    |

Limits that no decider can cross:

| Step            | Limit                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `review-triage` | A `critical` finding, or one with no severity, always gets the full validation. A finding with no severity could be critical (DOC-7). |
| `retry`         | Never above the attempt cap.                                                                                                          |
| `dispatch`      | May add reviewers, and never drops `security-auditor`.                                                                                |

Input on stdin and the answer on stdout, per step:

| Step            | Input                                                           | `answer`                                                  |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `review-triage` | `{finding: {file, title, body, diff_hunk, severity, category}}` | `auto-valid`, `auto-false-positive`, or `full-validation` |
| `retry`         | `{phase, attempt, failure_tail}`                                | `retry`, `fix`, or `ask-owner`                            |
| `dispatch`      | `{profile, changed_files, changed_lines, candidates}`           | The reviewers to add, which may be none                   |

Exit codes:

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Answered, also when the answer is a fallback                     |
| 2    | Environment error: no repository, or an unreadable configuration |
| 64   | Usage error: an unknown step, or invalid input                   |

### Decider configuration (Phase 3)

The repository's committed `.dotbabel.json` enables a model decider (KD-8):

```json
{
  "decider": {
    "adapter": "builtin",
    "steps": ["review-triage", "retry", "dispatch"]
  }
}
```

- `adapter` is `builtin` or `jev`.
- The adapter's API key lives in user scope, in the `TYPESAFE_API_KEY` environment variable, and never in a repository. No configuration file holds it.
- Without a key, the built-in rule answers, and the output has `fallback: true`.

### Host and platform adapters (Phase 2)

A host adapter exists for each CLI (`host`: `claude`, `codex`, `gemini`, and the others in `plugins/dotbabel/src/agents.mjs:99-230`). Each capability is `supported`, `unsupported`, or `unverified` (ARCH-4):

| Capability     | Meaning                          |
| -------------- | -------------------------------- |
| `identity`     | Which session runs this process  |
| `liveness`     | Whether a session is still alive |
| `preEdit`      | A hook before a file edit        |
| `preBash`      | A hook before a shell command    |
| `postTool`     | A hook after a tool call         |
| `sessionStart` | A hook at session start          |

A platform adapter exists for each operating system (`platform`: `linux`, `darwin`, `win32`):

| Capability | Meaning                            |
| ---------- | ---------------------------------- |
| `pin`      | Pin a command to a set of CPUs     |
| `cpuShare` | Give each session a fair CPU share |

- Each capability uses the Model Intelligence operation-capability shape (`docs/specs/model-intelligence/spec/5-interfaces-apis.md:230-248`).
- A fleet feature that needs an unsupported capability is off for that host or platform, and `dotbabel doctor` says so.

### Merge queue display (Phase 2)

The deny reason of a blocked token command (KD-6):

```text
The merge token is held by <holder>. You are 2nd in the queue.
Retry after its merge is recorded, or message <holder>.
```

```text
dotbabel fleet token [--json]   the holder, then the queue in order, each entry with its reservation expiry
dotbabel fleet token leave      leave the queue
```

### Exports (Phase 3)

```text
dotbabel export --a2a  <file>   the tasks, as A2A Task JSON
dotbabel export --otlp <file>   decisions and phase attempts, as OTLP JSON
```

A2A state mapping (DOC-12):

| Task            | A2A state              |
| --------------- | ---------------------- |
| Open, no phase  | `TASK_STATE_SUBMITTED` |
| Open, phase set | `TASK_STATE_WORKING`   |
| Closed          | `TASK_STATE_COMPLETED` |

- Blocked-by references go into metadata, not into a state.
- A closed task does not record why it closed (`plugins/dotbabel/src/task-state.mjs:216-225`), so every closed task maps to `TASK_STATE_COMPLETED`.

OTLP spans (DOC-13):

- `decide <step>`, with the decider, the answer, the confidence, and `fallback`. A model adapter adds `gen_ai.provider.name` and `gen_ai.request.model`.
- `phase <id>`, one span per receipt attempt, with its outcome.
- The file names the OpenTelemetry convention version it follows, because the agent conventions are still in development.

## Database Schema

<!-- Key tables/collections and their structure -->

### Task state, schema version 2 (Phase 1)

- Version 2 adds `depends_on`: an array of references (§5 Dependency references), which may be empty.
- The reader accepts versions 1 and 2. A version-1 file reads as `depends_on: []`. Today the reader accepts only version 1 (`plugins/dotbabel/src/task-state.mjs:58`, `:139`), and the schema forbids unknown fields (`schemas/dotbabel.task-state.schema.json`).
- The writer always writes version 2.
- An older dotbabel reports a version-2 file as invalid, with exit 2. The session-start hook still fails open.
- Decided on 2026-10-12, over an optional field at version 1.

### Clone registry (Phase 1)

`$XDG_STATE_HOME/dotbabel/graph/clones.json`:

```json
{
  "schema_version": 1,
  "repos": {
    "github.com/owner/repo": ["/abs/path/of/a/clone"]
  }
}
```

- A path that no longer exists is dropped on read.
- It is written atomically under a lock, as the merge token is (`plugins/dotbabel/src/fleet/token.mjs:80-92`).

### Merge queue (Phase 2)

- The token record (`plugins/dotbabel/src/fleet/token.mjs:146-155`) gains `queue: [{owner, joinedAt, reservedUntil}]`.
- `reservedUntil` is set when the token frees and the entry becomes the head (KD-6, REL-2).
- The token record's schema version goes up by one.

### Run receipt, schema version 2 (Phase 3)

- Each attempt gains `decisions: [{step, answer, decider, confidence, fallback, shadow}]`.
- `shadow` is `{decider, answer, confidence}`, or `null` when no adapter ran in shadow mode (KD-9).
- The reader accepts versions 1 and 2. Today the receipt is version 1, and an attempt allows no other fields (`schemas/dotbabel.run-receipt.schema.json`).
