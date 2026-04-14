# `@kaiohenricunha/harness`

Portable Claude Code plugin + zero-dependency npm package for
spec-driven-development governance. Installs seven CLI bins, a Node API
barrel, a destructive-git PreToolUse hook, and a gold-standard shell
settings validator.

This README is the npm tarball's entry point. **The full docs set lives at
<https://github.com/kaiohenricunha/dotclaude/tree/main/docs>.**

## Install

```bash
npm i -D @kaiohenricunha/harness
```

Zero runtime dependencies. Engines: Node `>=20`.

## Scaffold + validate

```bash
npx harness-init --project-name my-project --project-type node
npx harness-doctor           # self-diagnostic
npx harness-validate-specs   # or: npx harness validate-specs
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
} from "@kaiohenricunha/harness";

const ctx = createHarnessContext();
const { ok, errors } = validateSpecs(ctx); // errors are ValidationError instances
```

See [api-reference](https://github.com/kaiohenricunha/dotclaude/blob/main/docs/api-reference.md)
for the full surface.

## Bins

- `harness` — umbrella dispatcher (`harness validate-specs`, `harness doctor`, …)
- `harness-doctor` — self-diagnostic
- `harness-init` — scaffold governance tree
- `harness-validate-specs`, `harness-validate-skills`
- `harness-check-spec-coverage`, `harness-check-instruction-drift`
- `harness-detect-drift`

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
