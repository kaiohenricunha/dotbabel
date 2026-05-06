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
  "depends_on_specs": [],
  "active_prs": []
}
```

## Workflow

1. Draft → `status: draft`; no CI enforcement yet.
2. Approve → `status: approved`; files in `linked_paths` now require this spec (or a `No-spec rationale`) in any PR that touches them.
3. Implement → `status: implementing`; work in progress, same gating.
4. Done → `status: done`; spec remains as governance over linked_paths (Böckeler's "spec-anchored" mode).
