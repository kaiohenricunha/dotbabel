/**
 * Maps a repository permission level (`gh api repos/{repo}/collaborators/{login}/permission`)
 * to the closest GitHub `author_association` value, for code that only has a
 * login's permission and needs to compare it against a `trustedAssociations`
 * list expressed in `author_association` terms (`OWNER`, `MEMBER`,
 * `COLLABORATOR`, ...). Shared by `local-attest-runner.mjs` and
 * `criteria/trust-check.mjs` so the mapping cannot drift between the two.
 */
export const PERM_TO_ASSOC = Object.freeze({
  ADMIN: "OWNER",
  WRITE: "MEMBER",
  READ: "COLLABORATOR",
  MAINTAIN: "MEMBER",
  TRIAGE: "COLLABORATOR",
});
