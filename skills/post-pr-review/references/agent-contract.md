# Agent contract — JSON return shape for review agents

Each agent dispatched by `post-pr-review` MUST return EXACTLY ONE fenced
```json block. No prose before or after. Findings outside this contract are
silently dropped by the orchestrator.

## Schema

````json
{
  "agent": "security-auditor",
  "findings": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "start_line": null,
      "severity": "critical|important|suggestion",
      "category": "bug|style|test|comment|type|simplify|error-handling|security|design",
      "title": "<= 80 char headline",
      "body": "Markdown body. May include suggestion blocks.",
      "confidence": 92
    }
  ],
  "general_notes": "string or null — posted as the review body, not inline"
}
````

## Field semantics

| Field | Type | Required | Notes |
|---|---|---|---|
| `agent` | string | yes | Agent name. Echo your own name verbatim. |
| `findings` | array | yes | May be empty. |
| `findings[].path` | string | yes | Repo-relative path. Must match a file in the diff. |
| `findings[].line` | int | yes | NEW-side line number (the line in the new version). |
| `findings[].side` | enum | yes | `RIGHT` for additions/context (default), `LEFT` for old version. |
| `findings[].start_line` | int or null | no | For multi-line comments; otherwise null. |
| `findings[].severity` | enum | yes | `critical` (must fix before merge), `important` (should fix), `suggestion` (nit). |
| `findings[].category` | enum | yes | One of: `bug`, `style`, `test`, `comment`, `type`, `simplify`, `error-handling`, `security`, `design`. |
| `findings[].title` | string | yes | <= 80 chars, no markdown. |
| `findings[].body` | string | yes | Markdown. Suggestion blocks (` ```suggestion ` ... ` ``` `) are encouraged. |
| `findings[].confidence` | int | yes | 0–100. Findings with `< 80` are dropped by the orchestrator. |
| `general_notes` | string or null | yes | If non-null, posted as the top-level review body. Use for cross-cutting observations. |

## Why JSON, not markdown table

Tables break on multi-line bodies and code-suggestion blocks (` ```suggestion `).
JSON parses unambiguously and survives nested fenced blocks (the orchestrator
parses the outer block's contents, not its rendered form).

## Why `confidence ≥ 80`

To minimize false positives. The orchestrator inherits this bar by
hard-filtering anything below 80 — agents should self-rate honestly rather
than padding low-confidence noise.

## Example return (well-formed)

````json
{
  "agent": "security-auditor",
  "findings": [
    {
      "path": "src/api/client.ts",
      "line": 142,
      "side": "RIGHT",
      "start_line": null,
      "severity": "critical",
      "category": "security",
      "title": "API key hard-coded in source — rotate and move to env var",
      "body": "Line 142 commits a literal API key (`API_KEY = \"sk_live_...\"`). Even if removed in a follow-up commit, the value is permanently in git history and must be rotated upstream.\n\nSuggested fix:\n\n```suggestion\nconst API_KEY = process.env.STRIPE_API_KEY;\nif (!API_KEY) throw new Error('STRIPE_API_KEY missing');\n```\n\nAlso: add `STRIPE_API_KEY` to `.env.example` with a placeholder, and rotate the leaked key in the upstream provider dashboard.",
      "confidence": 99
    }
  ],
  "general_notes": null
}
````
