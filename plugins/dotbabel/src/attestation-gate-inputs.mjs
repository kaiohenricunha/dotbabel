/**
 * The attestation half of the merge-gate input gather.
 *
 * Lives here rather than in the bin, behind a `deps.run` seam, for the same
 * reason `criteria/gate-inputs.mjs` does: the whole gather can then be
 * exercised without a repository, a network, or a `gh` token. Every decision
 * that makes the trust model work is in this file — reading enforcement from
 * the base and not the head, the governed-file list, the `config_hash`
 * recomputation, the merge-base resolution — so leaving it untestable left the
 * trust model untested.
 *
 * Every value is read from the BASE ref, never the head. That is the model: a
 * pull request must not be able to switch enforcement off, widen its own trust
 * list, shrink the governed-file set, or drop a required leg, all of which it
 * could do by editing its own `.dotbabel.json` if the gate read the head.
 *
 * `.dotbabel.json` is JSON and read with `git show`, so evaluating the policy
 * never executes a line of the pull request's code. That is also why the policy
 * does not live in `.local-attest.config.mjs`, which is an executable module
 * and is hashed, never evaluated.
 *
 * @typedef {{run: (argv: string[]) => {status: number, stdout: string, stderr: string}}} GateDeps
 */

import { DEFAULT_GOVERNANCE_FILES, hashGovernanceFiles } from "./attestation.mjs";

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * A governed path must be a plain relative path inside the repository.
 *
 * The list comes from `.dotbabel.json` at the base ref, which is reviewed
 * content — but it reaches `git show`, and a path that escapes the repository
 * or carries shell metacharacters is a configuration bug worth refusing rather
 * than hashing around. Refusing is also the fail-closed direction: an entry the
 * gate will not read produces a hash that cannot match any producer's.
 */
const GOVERNED_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * True when a commit object is present in this clone.
 *
 * `git cat-file -e <sha>^{commit}` is the cheap existence probe: it resolves
 * the object and exits non-zero when it is absent. The criteria half runs the
 * same probe for the same reason — without it, "the base commit is not in this
 * clone" is indistinguishable from "the base ref declares no policy", and the
 * second answer silently disables the gate.
 *
 * @param {GateDeps} deps
 * @param {string} sha
 * @returns {boolean}
 */
function refIsReadable(deps, sha) {
  return deps.run(["git", "cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * A file's contents at a revision, or null when it is not there.
 *
 * Argv form, never a shell string: `path` comes from configuration, and this
 * file's sibling in `criteria/gate-inputs.mjs` records that an earlier revision
 * of the same call shape shipped a real command injection.
 *
 * @param {GateDeps} deps
 * @param {string} rev
 * @param {string} path
 * @returns {string|null}
 */
function showAtRev(deps, rev, path) {
  const r = deps.run(["git", "show", `${rev}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

/**
 * Build the attestation half of the merge-gate input.
 *
 * Returns `{}` when the base ref has not opted in, leaving `checkMergeGate` on
 * exactly its pre-attestation behaviour. That is the bootstrap path, and it is
 * deliberately distinct from an unreadable base, which blocks.
 *
 * @param {GateDeps} deps
 * @param {{headRefOid?: string, baseRefOid?: string}} view `gh pr view` JSON.
 * @param {object[]|null} comments Already-fetched PR comments, or null when unreadable.
 * @returns {object}
 */
export function attestationGateInputs(deps, view, comments) {
  const headSha = String(view?.headRefOid ?? "");
  const baseSha = String(view?.baseRefOid ?? "");
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) return {};

  // REL-21: an unreadable base is not "no policy". Probe before reading, so a
  // shallow clone, a stale worktree or an unfetched base fails closed with its
  // own reason instead of silently turning the whole ladder off.
  if (!refIsReadable(deps, baseSha)) {
    return {
      attestationEnforced: true,
      headRefOid: headSha,
      attestationBaseUnreadable: baseSha,
      attestationComments: comments,
    };
  }

  let policy = null;
  try {
    const raw = showAtRev(deps, baseSha, ".dotbabel.json");
    policy = raw === null ? null : JSON.parse(raw)?.attestation;
  } catch {
    // Unparseable base config: treat as no policy rather than guessing at one.
    // The base ref is the trunk's own committed state, so this is a repository
    // bug to fix on the trunk, not something a pull request can exploit.
    policy = null;
  }
  if (!policy || policy.enforce !== true) return {};

  const declared =
    Array.isArray(policy.governance_files) && policy.governance_files.length > 0
      ? policy.governance_files.map(String)
      : [...DEFAULT_GOVERNANCE_FILES];
  const governed = declared.filter((p) => GOVERNED_PATH_RE.test(p) && !p.includes(".."));

  // The merge base, not the base tip. It is the fork point, so it is stable
  // while the trunk advances and only a rebase moves it — and a rebase moves
  // the head SHA too, which the ladder already catches.
  const mb = deps.run(["git", "merge-base", baseSha, headSha]);
  const mergeBase = mb.status === 0 && mb.stdout.trim() !== "" ? mb.stdout.trim() : null;

  // Which governed files THIS pull request edits, as opposed to the base
  // having moved under it. The two look identical to the hash comparison — both
  // make the recorded hash differ from the base's — but they need opposite
  // recoveries: a moved base is fixed by rebasing and re-attesting, while an
  // edited governed file can never be authorized by evidence at all.
  //
  // Diffed from the MERGE BASE, so only the pull request's own side counts.
  // `null` means "cannot tell" and is kept distinct from `[]`, "known none": a
  // gate that collapsed the two would have to guess which one it was holding.
  let governedTouched = null;
  if (mergeBase !== null && governed.length > 0) {
    const d = deps.run(["git", "diff", "--name-only", mergeBase, headSha, "--", ...governed]);
    if (d.status === 0) {
      governedTouched = d.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    }
  }

  return {
    attestationEnforced: true,
    // Supplied here, not inherited from the criteria half: `criteriaGateInputs`
    // returns a bare `{}` whenever no spec is in scope, and a gather that
    // depended on that spread reported ATTESTATION_INVALID for every pull
    // request that happened to touch nothing spec-linked.
    headRefOid: headSha,
    attestationComments: comments,
    attestationTrustedAssociations: Array.isArray(policy.trusted_associations)
      ? policy.trusted_associations
      : ["OWNER"],
    requiredLegs: Array.isArray(policy.required_legs) ? policy.required_legs : [],
    expectedConfigHash: hashGovernanceFiles(
      governed.map((path) => ({ path, bytes: showAtRev(deps, baseSha, path) })),
    ),
    expectedMergeBase: mergeBase,
    attestationGovernedTouched: governedTouched,
  };
}
