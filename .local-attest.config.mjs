export default {
  // The `test` workflow (.github/workflows/test.yml) is gated off a local
  // attestation, so these legs must reproduce its `test` job exactly:
  // vitest+coverage, the validate-settings suite, and bats. lint/dogfood/
  // build-plugin are run too for full local pre-push confidence (their
  // workflows are not gated).
  matrix: [
    { name: "lint", mode: "hard", command: "npm run lint" },
    { name: "test", mode: "hard", command: "npm test -- --coverage" },
    {
      name: "validate-settings",
      mode: "hard",
      command: "bash plugins/dotbabel/tests/test_validate_settings.sh",
    },
    // Byte-identical to the workflow's bats step (.github/workflows/test.yml),
    // so the attested command and the CI command cannot drift apart. The
    // wrapper parallelises when GNU parallel or rush is installed and runs
    // serially otherwise. bats is by far the longest leg: ~125s serial,
    // ~56s at -j 8.
    { name: "bats", mode: "hard", command: "bash plugins/dotbabel/scripts/run-bats.sh" },
    { name: "dogfood", mode: "hard", command: "npm run dogfood" },
    { name: "build-plugin --check", mode: "hard", command: "npm run build-plugin -- --check" },
  ],
  pushAfterAttest: true,
  // CI's test job runs node 20 and 22 (.github/workflows/test.yml); a local
  // run can only certify one of them. Pin to 22 so an attest never silently
  // runs on some other Node — the 20-leg coverage is genuinely skipped under
  // attestation either way, which predates this pin.
  toolchain: { node: "22" },
};
