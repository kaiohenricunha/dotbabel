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
    { name: "bats", mode: "hard", command: "npx bats plugins/dotbabel/tests/bats/" },
    { name: "dogfood", mode: "hard", command: "npm run dogfood" },
    { name: "build-plugin --check", mode: "hard", command: "npm run build-plugin -- --check" },
  ],
  pushAfterAttest: true,
};
