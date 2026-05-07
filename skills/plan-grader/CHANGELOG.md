# plan-grader Changelog

## 2.0.0 - 2026-05-07

### Breaking Changes

- Initial rubric version for the reusable plan-grader skill.
- Establishes auto-reject behavior for dangerous caps.
- Sets risk handling and handoff quality to weight 0.10.
- Adds structured JSON output contract and three-tier confidence model.

### Added

- Cross-agent plan discovery policy for Claude, Codex, Copilot, and Gemini.
- Agent-aware paste-back prompt templates.
- Calibration anchors for score normalization.
- Rubric versioning policy.
