export default {
  // The `test` workflow (.github/workflows/test.yml) is gated off a local
  // attestation, so these legs must reproduce its `test` job exactly:
  // vitest+coverage, the validate-settings suite, and bats. lint/dogfood/
  // build-plugin are run too for full local pre-push confidence (their
  // workflows are not gated).
  //
  // This file is a GOVERNANCE FILE (.dotbabel.json -> attestation). Its bytes
  // are hashed into every attestation, and the merge gate recomputes that hash
  // from the base ref. Changing a command here is therefore not something a
  // pull request can do and then attest its own change with: the hashes
  // differ, the gate reports ATTESTATION_CONFIG_CHANGED, and the change lands
  // through explicit verification instead. That is deliberate — without it,
  // rewriting a leg to `true` would produce a truthful "test: pass".
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
    // The PR quality profile moved here from `/merge-pr` step 7. It belongs
    // in the attested matrix for two reasons: merge-pr ran it inside a
    // throwaway worktree that project-command trust can never match (so it
    // reported exit 2 far more often than it reported a verdict), and every
    // conductor commit carries `[skip ci]`, which suppresses the whole
    // workflow run — so `quality.yml` never fires on a conductor-driven pull
    // request either. Locally, from the real checkout, it is the only place
    // the policy actually gets measured.
    //
    // It re-executes lint and test internally, which the two legs above
    // already ran. That duplication is accepted: bats dominates the matrix
    // (~87s of 114s on #393) and the run still sheds more time at merge than
    // it adds here.
    {
      name: "quality",
      mode: "hard",
      // The PR's real base, not a hardcoded trunk: on a stacked pull request the
      // base is the parent branch, and grading against `main` would measure the
      // parent's diff too. The runner injects DOTBABEL_PR_BASE_REF for every leg.
      command:
        "node plugins/dotbabel/bin/dotbabel-quality.mjs check --profile pr --base \"origin/${DOTBABEL_PR_BASE_REF:-main}\"",
    },
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
