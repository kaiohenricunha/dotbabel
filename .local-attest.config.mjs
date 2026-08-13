export default {
  // The `test` workflow (.github/workflows/test.yml) is gated off a local
  // attestation, so these legs must reproduce its `test` job exactly:
  // vitest+coverage, the validate-settings suite, and bats. lint/dogfood/
  // build-plugin are run too for full local pre-push confidence (their
  // workflows are not gated).
  matrix: [
    { name: "lint", mode: "hard", command: "npm run lint" },
    { name: "test", mode: "hard", command: "npm test -- --coverage" },
    { name: "validate-settings", mode: "hard", command: "bash plugins/dotbabel/tests/test_validate_settings.sh" },
    // Same suite the workflow runs, through a wrapper that parallelises when
    // GNU parallel or rush is installed and runs serially when neither is.
    // bats is by far the longest leg: 194s serial, 64s at -j 8.
    { name: "bats", mode: "hard", command: "bash plugins/dotbabel/scripts/run-bats.sh" },
    { name: "dogfood", mode: "hard", command: "npm run dogfood" },
    { name: "build-plugin --check", mode: "hard", command: "npm run build-plugin -- --check" },
  ],
  pushAfterAttest: true,
};
