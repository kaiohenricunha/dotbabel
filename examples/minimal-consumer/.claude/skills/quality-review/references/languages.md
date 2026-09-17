# Language review reference

## Go

Review ignored errors, checked type assertions, goroutine ownership, bounded work, context propagation, cancellation, and resource closure.
Do not ban `any` or `interface{}`. Prefer a concrete type or a constrained generic only when it improves the contract.
Create an interface because a consumer needs an abstraction. Do not create it only to imitate a pattern.
Treat Go cover profiles as statement-block evidence. They do not contain real branch coverage.

## Python

Do not require static typing when the repository has no configured type checker. Review new explicit `Any` uses at changed boundaries.
Review bare exceptions, blanket handlers, empty handlers, mutable defaults, wildcard imports, and resource lifetime.

## TypeScript

Separate implicit `any` errors from explicit `any` review findings. Prefer `unknown` for untrusted input.
Require narrowing or runtime validation before use. Review direct assertions and prioritize double assertions such as `value as unknown as User`.

## JavaScript

Use the configured lint, syntax, coverage, complexity, duplication, and dead-code evidence. Do not claim TypeScript guarantees.
Use `checkJs`, `// @ts-check`, or JSDoc checks only when the repository selected that approach.
