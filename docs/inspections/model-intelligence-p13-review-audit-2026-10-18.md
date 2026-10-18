# P-13 review audit — 2026-10-18

The one protected four-role review of PR #505 at b1c3322 posts six findings covering four corrections. No second fleet is required for their fix delta. Autonomous authorization covers the corrections and their local proof.

## Root acquisition

Candidate one is an unsafe descriptor-relative child walk. Against it: each existing child open uses O_DIRECTORY/O_NOFOLLOW and operations stay anchored to held descriptors. Candidate two is an unsafe initial root acquisition. Confirmed at projection-fs.mjs:23-24: realpath checks ancestors, but a later absolute open follows any ancestor replaced between those calls. O_NOFOLLOW protects only the final component. The correction acquires the root by walking every component from a held filesystem-root descriptor, rejecting symlinks at each step.

## User edits during replacement

Candidate one is a manifest/hash ordering error. Against it: the transaction rechecks the target before writing and verifies generated output before committing its manifest. Candidate two is loss at the actual filesystem replacement. Confirmed at projection-fs.mjs:72: writing/fsyncing the temporary file leaves an edit window before rename overwrites the existing destination. A simple recheck leaves the same race immediately before rename. The replacement must retain the object actually displaced, validate it and restore/preserve any conflicting user content.

Node's public renameSync takes only oldPath/newPath; it exposes no exchange flag. Linux renameat2(RENAME_EXCHANGE) atomically swaps both objects, retaining the displaced destination. The chosen correction uses an isolated, fixed-operation Python 3 standard-library helper for this one syscall, with an inherited parent-directory fd, no shell, bounded output/timeout and no credential access. Python 3/libc/filesystem support is an explicit write precondition; missing support fails closed and installs nothing. Existing Python 3 and libc renameat2 are verified on this host. Conflicts or ambiguous helper failures retain the temporary object rather than destroying it. This external-tool requirement has a concrete security purpose; it adds no npm dependency or competing model logic.

## Repeated interruptions

Candidate one is a missing pending-only target in the path union. Against it: the initial orphan recovery correction already includes pending paths. Candidate two is loss of historical ownership when PENDING is replaced. Confirmed at transaction.mjs:54: the new pending manifest removes the only record for files written by an older interrupted generation. A second interruption can strand that file or leave an undetected orphan. The correction retains the ownership record for each live displaced generation until migration/removal completes. Orphans retire before new targets are written, keeping live records bounded. The committed deterministic manifest contains no recovery history.

## Public result documentation

The checker returns kind projection but DriftEntry still documents only instruction/symlink/generated. Extend that union. Regression proof and final verification follow these grounded diagnoses.

Sources: [Node filesystem API](https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath) and [Linux renameat2](https://man7.org/linux/man-pages/man2/rename.2.html).

## Correction evidence and limits

The five original review regressions fail before correction and pass afterward. The expanded safety file has 11 passing tests. It checks actual displaced user bytes, unchanged committed metadata on conflict, two successive journal interruptions with and without a committed base, pending orphan retirement, unavailable exchange support, edits at removal, unsafe retained paths and an inspection journal race. The combined projection and legacy sync subset passes 146 tests.

The corrected descriptor walk is `projection-fs.mjs:16-28`. Atomic exchange, retained objects and exclusive restoration are `projection-fs.mjs:48-53,89-133`. Pending ownership retention and orphan-first migration are `transaction.mjs:55-80`. Inspection checks both metadata generations at `transaction.mjs:95-100`.

A further byte-preservation boundary has two candidates: a changed output hash, which normally detects edits, and lossy UTF-8 decoding, which can equate invalid bytes with a valid replacement character. A new regression proves the latter: the reader previously decodes byte FF as U+FFFD, then accepts it as unchanged. Strict fatal decoding at `projection-fs.mjs:42` now rejects the malformed file and preserves its exact bytes. That test fails before the correction and passes afterward. A concurrent PR-profile run captures this deliberate red test and exits 1; it is recorded as a failed review attempt, followed by the passing budget gate and the retry decider. The final profile must run on stable corrected source.

Linux, `/proc/self/fd`, Python 3, libc `renameat2` and filesystem exchange support are required for replacing existing files. The npm dry-run confirms that the fixed Python helper ships in the package. No tool is installed. An unavailable or ambiguous exchange fails closed and retains temporary objects. A conflict can retain `name.<uuid>.tmp` beside the destination; these objects can contain user content and must not be automatically discarded. Inspect the destination and retained files before manual recovery. The mechanism protects displaced bytes at the replacement/removal boundary; it does not prevent later independent user edits.

The warmed public API measurement is 8.59 ms at p95 over ten runs, with zero network calls. The unchanged pure drift classifier still kills all 23 mutants at 100%. These results cover P-13's library boundary. They do not prove automatic CLI projection planning or completion of P-14 and later units.
