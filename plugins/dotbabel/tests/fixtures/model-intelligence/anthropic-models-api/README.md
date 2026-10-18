# Anthropic Models API fixture

Sanitized field subsets from the native-authorized GET /v1/models probe on Claude Code 2.1.302, observed 2026-10-18. The fixture keeps three publicly documented model identifiers and only capability/limit fields. It contains no credential, opaque authorization handle, account metadata, user settings or runtime availability assertion. Pagination fields describe this reduced fixture, not the full captured response. API-reported effort support is evidence from this source, not proof that Claude Code binds every value.

Primary contract: [Models API](https://platform.claude.com/docs/en/api/models/list). The native credential boundary is recorded in the Claude routing investigation; production adapters never read credential stores.
