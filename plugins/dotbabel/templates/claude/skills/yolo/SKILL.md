---
id: yolo
name: yolo
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [runtime-ops]
maturity: draft
description: >
  Start a temporary autonomy mode for this session: one approval from the owner
  covers a stated scope, and the session asks nothing else for work inside it
  until the scope is done, `/yolo off`, the expiry (4 h by default), or the end
  of the session. It still stops for force pushes, hard resets, deletions,
  production deploys, destroys, spec-text edits, a check it cannot fix, and
  work outside the scope.
argument-hint: "<scope> [--for 2h] [--merge|--no-merge] | off"
disable-model-invocation: true
user-invocable: true
---

# yolo

`disable-model-invocation: true` is deliberate. Only the owner can start this
mode, by typing `/yolo <scope>`. That command is the only approval.

The `yolo.sh` hook does the mechanical part (see
[docs/hooks.md](../../docs/hooks.md#yolosh)). When the owner types the command,
the hook writes a grant for this session and adds one context line. While the
grant lives, the hook approves the permission dialogs of this session, except
for a denylist. This skill does the rest: it tells you what the grant lets you
decide alone, and where you must still stop.

## 1. Read the grant line

Find the line the hook added to your context for this command. It starts with
one of these:

- `YOLO GRANT REMOVED` — the owner typed `/yolo off`. Tell the owner, in one
  sentence, that every permission default is back. Stop.
- `YOLO GRANT ACTIVE` — read the session, the expiry, the grant file path,
  `merge: yes|no`, and the scope from it. Go to step 2.
- Neither line — the hook is not registered, so no grant exists and every
  dialog still prompts. Tell the owner that `/yolo` needs the three `yolo.sh`
  entries from `docs/hooks.md#yolosh`, and stop. Do not start the scope as if
  it were autonomous.

Do not edit any settings file to make the mode work. The mode must never
change `settings.json` at runtime.

## 2. The standing grant

Tell the owner, in at most three lines: the scope, `merge: yes|no`, the expiry,
and the stops in step 3. Then start the work. Do not ask "should I start?".

The owner designates this session as autonomous for the scope in the grant
line, and only for that scope. This is the standing grant that the
"When designated as autonomous" clause of CLAUDE.md expects. Inside the scope,
it is the explicit instruction that these rules ask for:

- **Push.** Push the branches you create for the scope. Never force-push.
- **Plan and audit sign-off.** Where a rule says to wait for approval of a plan
  or an audit, write the plan or audit, state your choice, and continue.
- **Pull requests.** Open the pull requests the scope needs, run `/pr-conductor`,
  apply review fixes, and run local attestation.
- **Merge, only when `merge: yes`.** Merge each pull request in the scope when
  its required checks are green and its evidence covers the head SHA. Use the
  repository's merge path (`/merge-pr`, or `gh pr merge --squash`). Do not pass
  `--delete-branch`, because a branch deletion stays a stop. When `merge: no`,
  stop at a green pull request and report it.

Do not ask "push?", "merge?", "approved?", or "should I continue?" about a
decision inside the scope. Make the decision, and record it in the final
report.

Every other rule still applies: worktrees from `origin/main`, TDD, the full
test suite before a merge, the PR body sections, the protected-path Spec ID or
no-spec rationale, and the coordination with other sessions.

## 3. Where you still stop

Stop, report what you found and why you stopped, and ask one question, for
each of these:

1. A force push, `git reset --hard`, or any other command
   `guard-destructive-git.sh` asks for.
2. A deletion of a branch or a repository, including `gh pr merge --delete-branch`.
3. An `rm -r` outside your worktree.
4. `terraform destroy`, `tofu destroy`, or `apply -destroy`.
5. A production deploy or a release.
6. A check that fails and that you cannot fix inside the scope. Do not disable,
   skip, or weaken the check, and do not lower a threshold.
7. A change to owner-approved spec text (`docs/specs/`).
8. Any work outside the scope. If the scope does not clearly cover a step,
   treat it as outside.

The hook keeps the dialog for items 1 to 5 and 7 when Claude Code would show
one. It cannot see items 6 and 8, and it cannot add a dialog that your
settings or auto mode would skip. So these stops are your duty, not only the
hook's. Do not route around a stop: no bypass variable, no split or encoded
command, no script file, and no other session.

If a dialog shows for a step you expected to pass, the grant has possibly
expired. Report it, and do not ask the owner to approve a run of dialogs.

## 4. Finish

When the scope is done, or a stop ends the work:

1. Report the result. Give what is done, what remains, and each pull request
   with its link, its check state, and whether you merged it. Then give the
   decisions you made alone under the grant.
2. End the grant, as `/yolo off` does: remove the grant file named in the grant
   line with `rm -f <grant file>`.
3. Tell the owner in one line that the mode is off and every default is back.
