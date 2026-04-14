# `@dotclaude/dotclaude`

Portable Claude Code plugin + zero-dependency npm package for
spec-driven-development governance. Installs seven CLI bins, a Node API
barrel, a destructive-git PreToolUse hook, and a gold-standard shell
settings validator.

This README is the npm tarball's entry point. **The full docs set lives at
<https://github.com/kaiohenricunha/dotclaude/tree/main/docs>.**

## Install

```bash
npm i -D @dotclaude/dotclaude
```

Zero runtime dependencies. Engines: Node `>=20`.

## Scaffold + validate

```bash
npx dotclaude-init --project-name my-project --project-type node
npx dotclaude-doctor           # self-diagnostic
npx dotclaude-validate-specs   # or: npx dotclaude validate-specs
```

## Node API

```js
import {
  createHarnessContext,
  validateSpecs,
  validateManifest,
  checkSpecCoverage,
  checkInstructionDrift,
  scaffoldHarness,
  ValidationError,
  ERROR_CODES,
  EXIT_CODES,
} from "@dotclaude/dotclaude";

const ctx = createHarnessContext();
const { ok, errors } = validateSpecs(ctx); // errors are ValidationError instances
```

See [api-reference](https://github.com/kaiohenricunha/dotclaude/blob/main/docs/api-reference.md)
for the full surface.

## Bins

- `dotclaude` — umbrella dispatcher (`harness validate-specs`, `harness doctor`, …)
- `dotclaude-doctor` — self-diagnostic
- `dotclaude-init` — scaffold governance tree
- `dotclaude-validate-specs`, `dotclaude-validate-skills`
- `dotclaude-check-spec-coverage`, `dotclaude-check-instruction-drift`
- `dotclaude-detect-drift`

Every bin supports `--help`, `--version`, `--json`, `--verbose`, `--no-color`.

## Exit codes

`{OK:0, VALIDATION:1, ENV:2, USAGE:64}` — `64` mirrors BSD `sysexits.h EX_USAGE`.

## License

MIT. See <https://github.com/kaiohenricunha/dotclaude/blob/main/LICENSE>.

## Links

- [Changelog](https://github.com/kaiohenricunha/dotclaude/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/kaiohenricunha/dotclaude/blob/main/CONTRIBUTING.md)
- [Security](https://github.com/kaiohenricunha/dotclaude/blob/main/SECURITY.md)
- [Quickstart](https://github.com/kaiohenricunha/dotclaude/blob/main/docs/quickstart.md)
- [Troubleshooting](https://github.com/kaiohenricunha/dotclaude/blob/main/docs/troubleshooting.md)
