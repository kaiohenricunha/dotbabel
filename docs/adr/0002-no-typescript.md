# ADR-0002 — No TypeScript

**Status**: Accepted (2026-04-14); revisit at v0.3

## Context

Every new Node package defaults to TypeScript. For `@dotbabel/dotbabel`
the question was whether to adopt TS from day one or stay on plain `.mjs`
with JSDoc.

## Decision

**Plain JavaScript ESM + JSDoc `@typedef`s. No TypeScript.**

- Source is `.mjs` only, no `.ts`.
- Every `export` gets a JSDoc block — enforced by
  `scripts/check-jsdoc-coverage.mjs` in CI.
- Public types live as JSDoc `@typedef`s (`HarnessContext`,
  `ValidationResult`, `StructuredError`, …) consumed via
  `/** @type {import('./spec-harness-lib.mjs').HarnessContext} */` in
  consumer code.
- Zero runtime deps, zero build step, zero transpile — the tarball ships
  source as-authored.

## Consequences

- **No transpile.** `npm publish` ships the code verbatim. Debugging shows
  the same file paths consumers see. Source maps are irrelevant.
- **Instant `npx`**. No TS compile step, no dev/prod parity concerns.
- **Editor inference** works in VSCode / Neovim / anything that reads
  JSDoc — about 85 % of what TS provides for API surface work.
- **No `.d.ts`.** Consumers who want stronger types in their projects get
  JSDoc inference today. A hand-written `index.d.ts` is a v0.3+ option
  (not blocking).
- **Loss of advanced type features** — branded types, conditional types,
  mapped types. Cost is low for a validator/CLI library.
- **Linting is weaker.** Prettier + shellcheck + `scripts/check-jsdoc-coverage.mjs`
  cover most of the ground; we explicitly are not running `tsc --noEmit`.

## Alternatives considered

- **TypeScript with `tsc --noEmit` type-checking, `.mjs` as source** — half
  the complexity of full TS adoption. Rejected because CI still has to run
  `tsc` on PRs (slow) and consumers still need to maintain `.d.ts`
  provenance. Benefit is marginal.
- **Full TypeScript, ship compiled `.mjs`** — standard for most libraries.
  Rejected on the "zero runtime deps + zero build step" aesthetic: the
  harness is supposed to be embarrassingly simple to read. A transpile
  step contradicts that.
- **Ship `.d.ts` hand-authored today** — deferred. The JSDoc coverage gate
  already provides most of the editor experience. Revisit when a consumer
  files a specific request.

## Revisit triggers

- A consumer filing an issue about type gaps that JSDoc can't close.
- A public-API change large enough that hand-authored `.d.ts` becomes
  maintenance burden.
- An ecosystem shift (e.g. Node gaining first-class type-stripping) that
  changes the cost/benefit.
