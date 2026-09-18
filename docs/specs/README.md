# Specs

Each spec lives in its own directory with a `spec.json` metadata file and supporting markdown.

## Layout

```
docs/specs/
├─ <slug>/
│  ├─ spec.json          Required metadata
│  ├─ spec.md            Human-readable spec
│  └─ (requirements.md, design.md, tasks.md — optional phase docs)
└─ README.md             This file
```

## spec.json schema

```json
{
  "id": "unique-slug-matching-dir-name",
  "title": "Human title",
  "status": "draft | approved | implementing | done",
  "owners": ["Person Name"],
  "linked_paths": ["glob", "patterns", "of/files/this/spec/covers/**"],
  "acceptance_commands": ["npm test", "go test ./..."],
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "status": "planned | active",
      "given": "a starting condition",
      "when": "an action or event",
      "then": "the expected, testable outcome",
      "tests": [{ "file": "path/to/test.mjs", "name": "the exact test name" }],
      "argv": ["the", "command", "that", "runs", "those", "tests"],
      "report": { "format": "junit-xml", "path": "path/to/report.xml" }
    }
  ],
  "depends_on_specs": [],
  "active_prs": []
}
```

`acceptance_criteria` is optional. `status` defaults to `active` when absent; a
`planned` criterion is recorded and does not run. `report` is optional too.
`dotbabel-validate-specs` checks only the shape shown above — an id matching
`AC-<number>`, a non-empty `given`/`when`/`then`, at least one entry in
`tests`, and a non-empty `argv`. It never reads the named test file or runs
`argv`; that happens at verification time.

## Workflow

1. Draft → `status: draft`; no CI enforcement yet.
2. Approve → `status: approved`; files in `linked_paths` now require this spec (or a `No-spec rationale`) in any PR that touches them.
3. Implement → `status: implementing`; work in progress, same gating.
4. Done → `status: done`; spec remains as governance over linked_paths (Böckeler's "spec-anchored" mode — an opt-in steady state for repos that want long-lived PR-time gates, not the default for casual feature work).

### Moving a spec to `done`

`done` is a claim that the spec's criteria hold, so establish it before you
write it, not after:

```bash
dotbabel criteria verify --spec <id>
```

Every criterion must be `active` and must pass. A `planned` criterion is
recorded but never run (IMPL-5 puts a criterion into `active` only in the pull
request that adds its tests), so a spec still carrying one has an untested claim
in it and is not done.

Then run the `/validate-spec <id>` audit and resolve every CRITICAL finding.
Only then set `"status": "done"`.

Warning: `done` does not retire the spec. Files in `linked_paths` still require
it in any pull request that touches them, so a `done` spec whose criteria later
break becomes a gate that fails on unrelated work.
