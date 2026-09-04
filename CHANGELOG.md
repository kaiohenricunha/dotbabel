# Changelog

All notable changes to `@dotbabel/dotbabel` land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

Historical entries below v2.0.0 reference the legacy package name
`@dotclaude/dotclaude` and the legacy `plugins/dotclaude/` path — these are
preserved verbatim because they describe state at the time of release.

## Unreleased

## [3.1.0](https://github.com/kaiohenricunha/dotbabel/compare/v3.0.0...v3.1.0) (2026-09-04)


### Added

* **project-sync:** add cli_excluded, a per-CLI command and skill allowlist ([#219](https://github.com/kaiohenricunha/dotbabel/issues/219) A) ([#323](https://github.com/kaiohenricunha/dotbabel/issues/323)) ([7ebed08](https://github.com/kaiohenricunha/dotbabel/commit/7ebed08e1427d7a0794f6335da17773113a9870a))


### Documentation

* **project-sync:** document the verbatim-symlink fan-out limitation ([#219](https://github.com/kaiohenricunha/dotbabel/issues/219) B-3) ([#321](https://github.com/kaiohenricunha/dotbabel/issues/321)) ([5b5c127](https://github.com/kaiohenricunha/dotbabel/commit/5b5c1279f8f9a56a02a401a61b30ba1cc345e4b6))

## [3.0.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.18.2...v3.0.0) (2026-09-03)


### ⚠ BREAKING CHANGES

* the `dotclaude` read-fallback layer is removed. Users still on `~/.config/dotclaude/`, `~/.cache/dotclaude/`, or any `DOTCLAUDE_*` environment variable must migrate before upgrading — those names are now ignored silently, with no deprecation warning. The `DOTBABEL_LEGACY_CONFIG`, `DOTBABEL_LEGACY_CACHE`, and `DOTBABEL_LEGACY_ENV` warning codes no longer exist. See the "2.x -> 3.0.0" section of docs/upgrade-guide.md.

### Added

* remove dotclaude compat shims ([#317](https://github.com/kaiohenricunha/dotbabel/issues/317)) ([388f7ba](https://github.com/kaiohenricunha/dotbabel/commit/388f7ba4469bd6ed13c9a0f719304527f704eb7b))

## [2.18.2](https://github.com/kaiohenricunha/dotbabel/compare/v2.18.1...v2.18.2) (2026-08-15)


### Fixed

* **release:** regen the plugin manifest after the version bump ([#315](https://github.com/kaiohenricunha/dotbabel/issues/315)) ([3d8c8ce](https://github.com/kaiohenricunha/dotbabel/commit/3d8c8ce611284032aefa0556b6bac9032c2e9fca))

## [2.18.1](https://github.com/kaiohenricunha/dotbabel/compare/v2.18.0...v2.18.1) (2026-08-15)


### Fixed

* **plugin:** make the plugin installable and add a marketplace manifest ([#311](https://github.com/kaiohenricunha/dotbabel/issues/311)) ([c962087](https://github.com/kaiohenricunha/dotbabel/commit/c96208776abbfa71517fc8cf36a5ee2de6b29720))


### Documentation

* lead with verification discipline, not CI cost ([#313](https://github.com/kaiohenricunha/dotbabel/issues/313)) ([6efec10](https://github.com/kaiohenricunha/dotbabel/commit/6efec10bbc8e0d30e50da0cc74acd56612c3a3d7))
* **rule-floor:** require agents to clean up their own worktrees ([#314](https://github.com/kaiohenricunha/dotbabel/issues/314)) ([5fa5911](https://github.com/kaiohenricunha/dotbabel/commit/5fa5911d0030d4b254166e4c0ab8cad9e4e6c1e9))

## [2.18.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.17.1...v2.18.0) (2026-08-14)


### Added

* **local-attest:** --init drafts a matrix from .github/workflows ([#309](https://github.com/kaiohenricunha/dotbabel/issues/309)) ([541b82e](https://github.com/kaiohenricunha/dotbabel/commit/541b82eeba84ff78ad163ee970222fb4c1ed65da))

## [2.17.1](https://github.com/kaiohenricunha/dotbabel/compare/v2.17.0...v2.17.1) (2026-08-14)


### Fixed

* **tests:** drop fs.globSync — Node 20 leg red on main ([#306](https://github.com/kaiohenricunha/dotbabel/issues/306)) ([1ee3225](https://github.com/kaiohenricunha/dotbabel/commit/1ee322500d0c9f464e177e5578ef5b8ec9cddc32))

## [2.17.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.16.0...v2.17.0) (2026-08-14)


### Added

* **local-attest:** diagnostic modes, failure-complete audit log, toolchain pins ([#300](https://github.com/kaiohenricunha/dotbabel/issues/300)) ([20deb8c](https://github.com/kaiohenricunha/dotbabel/commit/20deb8c3d7a5bb7524bc0b4a4e0133735e687831))
* **local-attest:** lanes, diff-gated legs, worktree restore, PR-body env ([#301](https://github.com/kaiohenricunha/dotbabel/issues/301)) ([34f77b3](https://github.com/kaiohenricunha/dotbabel/commit/34f77b34fc95b4da6c81425925f385308d6d3b7d))


### Fixed

* **bin:** resolve argv[1] symlinks in the run-direct guard ([#302](https://github.com/kaiohenricunha/dotbabel/issues/302)) ([584e11a](https://github.com/kaiohenricunha/dotbabel/commit/584e11ace08592bd9e39589321520c482d4a6234))
* **pr-conductor:** close the four deferred review findings ([#299](https://github.com/kaiohenricunha/dotbabel/issues/299)) ([98c1a98](https://github.com/kaiohenricunha/dotbabel/commit/98c1a980aaf699db44e9044a8d2f979964a66596))
* **release:** stop squash merges from suppressing release-please [skip ci] ([#303](https://github.com/kaiohenricunha/dotbabel/issues/303)) ([8a1f64a](https://github.com/kaiohenricunha/dotbabel/commit/8a1f64aa34e840a9a44be1171fa2300fea75dee0))


### Performance

* **pr-conductor:** cut redundant passes and parallelise the bats suite ([#298](https://github.com/kaiohenricunha/dotbabel/issues/298)) ([4488f54](https://github.com/kaiohenricunha/dotbabel/commit/4488f547bfba83e3fabb18f620c0d6ae5a30e478))


### Documentation

* **merge-pr:** clean the squash subject too — single-commit PRs inherit it ([#305](https://github.com/kaiohenricunha/dotbabel/issues/305)) ([5bfbc61](https://github.com/kaiohenricunha/dotbabel/commit/5bfbc61862efed5bcc2f857f51b99ffaaa5822a5))

## [2.16.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.15.0...v2.16.0) (2026-08-13)


### Added

* **project-sync:** add fan_out_layout, sharing one skills tree across CLIs ([#296](https://github.com/kaiohenricunha/dotbabel/issues/296)) ([a397d41](https://github.com/kaiohenricunha/dotbabel/commit/a397d41da62f7cf065128194f1c926a6f5b5c889))

## [2.15.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.14.0...v2.15.0) (2026-08-12)


* release as 2.15.0 ([#294](https://github.com/kaiohenricunha/dotbabel/issues/294)) ([95d7558](https://github.com/kaiohenricunha/dotbabel/commit/95d7558f403a6b49d7a971485e88ef15e3d94744))


### Fixed

* **hooks:** filter toolchain noise per line, and match it case-insensitively ([#293](https://github.com/kaiohenricunha/dotbabel/issues/293)) ([0ab3222](https://github.com/kaiohenricunha/dotbabel/commit/0ab322299f977cb6fbdb148c3cc917d9956599b3))
* **project-sync:** gate the drift check on CLI presence, validate fan_out ([#292](https://github.com/kaiohenricunha/dotbabel/issues/292)) ([a4e8cf7](https://github.com/kaiohenricunha/dotbabel/commit/a4e8cf79a71ef9d908ef09603e29ed40e02ac851))


### Documentation

* document check-on-write, check-on-stop, and the trust model ([#290](https://github.com/kaiohenricunha/dotbabel/issues/290)) ([bd2b196](https://github.com/kaiohenricunha/dotbabel/commit/bd2b196c396f59eac2c0ce83645f047b92a101aa))

## [2.14.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.13.0...v2.14.0) (2026-08-12)


### Added

* **hooks:** add check-on-stop Stop-event project gate ([#281](https://github.com/kaiohenricunha/dotbabel/issues/281)) ([fee0f32](https://github.com/kaiohenricunha/dotbabel/commit/fee0f320e592d6f8dee49486a7a5049a587e6fac))
* **hooks:** add check-on-write PostToolUse syntax gate ([#280](https://github.com/kaiohenricunha/dotbabel/issues/280)) ([4695622](https://github.com/kaiohenricunha/dotbabel/commit/4695622de8770ef2085504a43f121dce7f590a16))
* **project-init:** add --trust to grant check-on-stop trust ([#289](https://github.com/kaiohenricunha/dotbabel/issues/289)) ([2dbe867](https://github.com/kaiohenricunha/dotbabel/commit/2dbe8673969142178bda72860b4dbefe20ceb841))


### Fixed

* **check-on-stop:** find project markers per sub-project, not at the root ([#287](https://github.com/kaiohenricunha/dotbabel/issues/287)) ([5ba6772](https://github.com/kaiohenricunha/dotbabel/commit/5ba677291a6066019abac7af5e0bdacfe66ed29d))
* **check-on-stop:** parse porcelain with -z and --untracked-files=all ([#283](https://github.com/kaiohenricunha/dotbabel/issues/283)) ([d3fc8dc](https://github.com/kaiohenricunha/dotbabel/commit/d3fc8dcc9dcf5fa406af6c61fa6d6ba17182554c))
* **local-attest:** re-check HEAD after the matrix before publishing ([#286](https://github.com/kaiohenricunha/dotbabel/issues/286)) ([61aa474](https://github.com/kaiohenricunha/dotbabel/commit/61aa474e6050843eb8f2242ca96c54f26e5690ff))
* **release-conductor:** fetch tags before deriving LAST_TAG [skip ci] ([#282](https://github.com/kaiohenricunha/dotbabel/issues/282)) ([465a26b](https://github.com/kaiohenricunha/dotbabel/commit/465a26b4059e55ef4e118a6a30d9d94250652a81))
* **security:** bump js-yaml to 4.3.1 and harden argv-built subprocesses ([#288](https://github.com/kaiohenricunha/dotbabel/issues/288)) ([5db4e72](https://github.com/kaiohenricunha/dotbabel/commit/5db4e72e37fced75817ec0d0dac6eeb8eb245961))


### Documentation

* **rules:** add ASD-STE100 Simplified Technical English to rule floor ([#284](https://github.com/kaiohenricunha/dotbabel/issues/284)) ([b08527c](https://github.com/kaiohenricunha/dotbabel/commit/b08527c64c525266024a0a8404b64bbda0f681f8))

## [2.13.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.12.0...v2.13.0) (2026-08-08)


### Added

* **skills:** add /pr-conductor with a tested stacked-PR core ([#278](https://github.com/kaiohenricunha/dotbabel/issues/278)) ([60304bd](https://github.com/kaiohenricunha/dotbabel/commit/60304bde040b0d7ac4082cce2ba3d9fac7db1f69))
* **skills:** add /release-conductor as a skill ([#276](https://github.com/kaiohenricunha/dotbabel/issues/276)) ([1a14a56](https://github.com/kaiohenricunha/dotbabel/commit/1a14a56895fc8212c9c875699f9e630ded0873de))


### Fixed

* **post-pr-review:** resolve.sh requested a gh field that does not exist ([#279](https://github.com/kaiohenricunha/dotbabel/issues/279)) ([a53bb52](https://github.com/kaiohenricunha/dotbabel/commit/a53bb52701a09141053f96d5b49d6097766a7fee))

## [2.12.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.11.1...v2.12.0) (2026-08-07)


### Added

* **validate-specs:** fail unquantified NFR constraints ([#274](https://github.com/kaiohenricunha/dotbabel/issues/274)) ([5c4e31b](https://github.com/kaiohenricunha/dotbabel/commit/5c4e31b0397345bf432fe26f72108d1121bad434))


### Documentation

* **rule-floor:** enforce hard caps on response length and shape ([#273](https://github.com/kaiohenricunha/dotbabel/issues/273)) ([8782497](https://github.com/kaiohenricunha/dotbabel/commit/8782497cac57f7ab2684aee2a35d23efee2998f1))

## [2.11.1](https://github.com/kaiohenricunha/dotbabel/compare/v2.11.0...v2.11.1) (2026-08-07)


### Fixed

* **ci:** re-fire body-gated checks on edit, document the Spec ID rule ([#271](https://github.com/kaiohenricunha/dotbabel/issues/271)) ([cb67f33](https://github.com/kaiohenricunha/dotbabel/commit/cb67f33de4bf57118fdfd5b86d74d49b51d28185))

## [2.11.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.10.0...v2.11.0) (2026-08-07)


### Added

* **spec:** harden scaffolds against unverifiable specs ([#265](https://github.com/kaiohenricunha/dotbabel/issues/265)) ([c1f6853](https://github.com/kaiohenricunha/dotbabel/commit/c1f68532a58ddfb578c2fee2ba288b044ce29553))

## [2.10.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.9.0...v2.10.0) (2026-06-14)


### Added

* **skills:** add /reproduce-bug skill for isolated bug reproduction ([#243](https://github.com/kaiohenricunha/dotbabel/issues/243)) ([d0d487e](https://github.com/kaiohenricunha/dotbabel/commit/d0d487e75455ab9144f682925f3a9597ed607ea0))

## [2.9.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.8.0...v2.9.0) (2026-06-05)


### Added

* **build-plugin:** generate plugin.json skills + agents from the index ([#239](https://github.com/kaiohenricunha/dotbabel/issues/239)) ([beeb44a](https://github.com/kaiohenricunha/dotbabel/commit/beeb44a9d011a7ce11066c54c33eeff387421897))
* **skills,agents:** add allowed-tools guardrails and agent skill inheritance ([#238](https://github.com/kaiohenricunha/dotbabel/issues/238)) ([55b921c](https://github.com/kaiohenricunha/dotbabel/commit/55b921ce0da1692d55d987e2371ec9a21ff6785a))

## [2.8.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.7.0...v2.8.0) (2026-05-23)


### Added

* add code-simplifier skill (cross-agent portable) ([#232](https://github.com/kaiohenricunha/dotbabel/issues/232)) ([6541e6e](https://github.com/kaiohenricunha/dotbabel/commit/6541e6eaaf70d22b88a2655f02ca062cbc0ddbb3))
* add portable /local-attest skill for local CI attestation ([#236](https://github.com/kaiohenricunha/dotbabel/issues/236)) ([a643850](https://github.com/kaiohenricunha/dotbabel/commit/a643850b8e1eb611edeec2d2e9c676bf46faf0f5))
* **skills:** add portable /flyctl skill for fly.io ops ([#231](https://github.com/kaiohenricunha/dotbabel/issues/231)) ([89a29a7](https://github.com/kaiohenricunha/dotbabel/commit/89a29a7bf9fef02dfcfefa0c7842af41cc6ea981))


### Documentation

* **contributing:** add skill-scaffolding section using /flyctl as worked example ([#234](https://github.com/kaiohenricunha/dotbabel/issues/234)) ([776db89](https://github.com/kaiohenricunha/dotbabel/commit/776db89e7f8e0430aedcffada362a5fb8dc7ebe4))

## [2.7.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.6.1...v2.7.0) (2026-05-10)


### Added

* **bootstrap:** add user-scope rule-floor overlay (closes [#228](https://github.com/kaiohenricunha/dotbabel/issues/228)) ([#229](https://github.com/kaiohenricunha/dotbabel/issues/229)) ([0efe030](https://github.com/kaiohenricunha/dotbabel/commit/0efe030057ec108d4c9c557b9fba074b8e4e84a4))

## [2.6.1](https://github.com/kaiohenricunha/dotbabel/compare/v2.6.0...v2.6.1) (2026-05-09)


### Fixed

* **index:** emit prettier-compatible JSON from writer (closes [#224](https://github.com/kaiohenricunha/dotbabel/issues/224)) ([#226](https://github.com/kaiohenricunha/dotbabel/issues/226)) ([2121f7d](https://github.com/kaiohenricunha/dotbabel/commit/2121f7df435ff5c0fd9bc2b5183a5c3a5dbb536c))

## [2.6.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.5.0...v2.6.0) (2026-05-09)


### Added

* **project-sync:** dogfood per-repo cross-CLI fan-out on dotbabel itself ([#221](https://github.com/kaiohenricunha/dotbabel/issues/221)) ([252f475](https://github.com/kaiohenricunha/dotbabel/commit/252f475041510d360c693968c5eb635c864f11e7))

## [2.5.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.4.0...v2.5.0) (2026-05-09)


### Added

* **project-sync:** add cross-CLI repo-local fan-out (closes [#205](https://github.com/kaiohenricunha/dotbabel/issues/205)) ([#216](https://github.com/kaiohenricunha/dotbabel/issues/216)) ([9c24184](https://github.com/kaiohenricunha/dotbabel/commit/9c2418497c77d895927c5863a79e3fbba070bbea))


### Fixed

* **project-sync:** write relative symlink targets (closes [#218](https://github.com/kaiohenricunha/dotbabel/issues/218)) ([#220](https://github.com/kaiohenricunha/dotbabel/issues/220)) ([f8bcb75](https://github.com/kaiohenricunha/dotbabel/commit/f8bcb75a438d3a260be95f8ab696ac35dcaef0d8))

## [2.4.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.3.0...v2.4.0) (2026-05-09)


### Added

* **bootstrap:** honor GEMINI_HOME for parity with CODEX_HOME ([#207](https://github.com/kaiohenricunha/dotbabel/issues/207)) ([0f1efbf](https://github.com/kaiohenricunha/dotbabel/commit/0f1efbf3ce2db861c478a94aee7cf8f6ce114864))
* **doctor:** validate codex/gemini skill fan-out symlinks ([#210](https://github.com/kaiohenricunha/dotbabel/issues/210)) ([27b1302](https://github.com/kaiohenricunha/dotbabel/commit/27b13023c3efa8cc364473033d0d18d7f4822d50))


### Documentation

* **bootstrap:** document codex/gemini skill fan-out paths ([#211](https://github.com/kaiohenricunha/dotbabel/issues/211)) ([52df8a7](https://github.com/kaiohenricunha/dotbabel/commit/52df8a759b5b1e1519d3a9123093fa14d469af16))
* **handoff:** SKILL.md flags + layered-fidelity section + cli enum ([#208](https://github.com/kaiohenricunha/dotbabel/issues/208)) ([b481995](https://github.com/kaiohenricunha/dotbabel/commit/b481995241935b704d8c55a96f6b47f6518b8975))

## [2.3.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.2.0...v2.3.0) (2026-05-08)


### Added

* **bootstrap:** fan out skills/ + commands/ into ~/.codex/skills ([0dddedf](https://github.com/kaiohenricunha/dotbabel/commit/0dddedf81a96eac3f3f3512aedeeed2173d26f3f))
* **bootstrap:** fan out skills/ + commands/ into ~/.gemini/skills ([6590709](https://github.com/kaiohenricunha/dotbabel/commit/6590709b225ad2685700f0cafa4583d4deffb228))
* **handoff:** layered fidelity — B-floor extraction + A state-block opt-in ([#203](https://github.com/kaiohenricunha/dotbabel/issues/203)) ([ebee76d](https://github.com/kaiohenricunha/dotbabel/commit/ebee76dc929e18b1089f3368b7538355377c510b))

## [2.2.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.1.0...v2.2.0) (2026-05-08)


### Added

* **instructions:** cross-CLI rule-floor parity gates ([#200](https://github.com/kaiohenricunha/dotbabel/issues/200)) ([21b5a29](https://github.com/kaiohenricunha/dotbabel/commit/21b5a2900cc6ad51de7f1285558e18c74c586835))
* **skills:** add post-pr-review for Copilot-style PR commenting ([#198](https://github.com/kaiohenricunha/dotbabel/issues/198)) ([94646db](https://github.com/kaiohenricunha/dotbabel/commit/94646db38f8a079452e2334fbd93ed830143bf05))

## [2.1.0](https://github.com/kaiohenricunha/dotbabel/compare/v2.0.1...v2.1.0) (2026-05-07)

### Added

- **plan-grader:** add reusable plan grader skill ([#194](https://github.com/kaiohenricunha/dotbabel/issues/194)) ([78bd8cc](https://github.com/kaiohenricunha/dotbabel/commit/78bd8cc76286eb731bf4c44b8f82088c8c48ddc2))

## [2.0.1](https://github.com/kaiohenricunha/dotbabel/compare/v2.0.0...v2.0.1) (2026-05-07)

### Fixed

- **readme:** align lead description with model-agnostic positioning ([#192](https://github.com/kaiohenricunha/dotbabel/issues/192)) ([270a394](https://github.com/kaiohenricunha/dotbabel/commit/270a39400b08fa92a49c5d763d38aa7bed8915d0))

## [2.0.0](https://github.com/kaiohenricunha/dotbabel/compare/v1.3.0...v2.0.0) (2026-05-06)

### ⚠ BREAKING CHANGES

- rename project from dotclaude to dotbabel ([#186](https://github.com/kaiohenricunha/dotbabel/issues/186))

### Added

- **core:** migrate complex commands to skills ([#177](https://github.com/kaiohenricunha/dotbabel/issues/177)) ([13c105e](https://github.com/kaiohenricunha/dotbabel/commit/13c105e644be6f20bb446c0cd37a857dfaa2f7a9))
- **handoff:** implement Gemini support ([#185](https://github.com/kaiohenricunha/dotbabel/issues/185)) ([1234b60](https://github.com/kaiohenricunha/dotbabel/commit/1234b6013109deba2075c6c8ff830e9cd44c1cff))
- rename project from dotclaude to dotbabel ([#186](https://github.com/kaiohenricunha/dotbabel/issues/186)) ([5136140](https://github.com/kaiohenricunha/dotbabel/commit/51361409e3c75628c1cf54b8a8624ce79fdb44f3))
- **skills:** add deploy status and rollback workflows ([#182](https://github.com/kaiohenricunha/dotbabel/issues/182)) ([28120b4](https://github.com/kaiohenricunha/dotbabel/commit/28120b40c2d90f58aff19b20ef2684df8ddf8fc2))

### Fixed

- **handoff:** partition push --delete stderr for accurate prune reporting ([#183](https://github.com/kaiohenricunha/dotbabel/issues/183)) ([7fa6b7f](https://github.com/kaiohenricunha/dotbabel/commit/7fa6b7f16c99d3477a26d23c63823d8652f01139))
- **handoff:** seed main as transport repo default during bootstrap ([#184](https://github.com/kaiohenricunha/dotbabel/issues/184)) ([6c3dabf](https://github.com/kaiohenricunha/dotbabel/commit/6c3dabffd974df94035306f9630dbb8bb368fcd5))

### Documentation

- clarify skills and command inventory ([#175](https://github.com/kaiohenricunha/dotbabel/issues/175)) ([42e1b5f](https://github.com/kaiohenricunha/dotbabel/commit/42e1b5f465d95462b9c684e24c172b058759b8bb))

## [2.0.0] - YYYY-MM-DD

### BREAKING CHANGES

- **rebrand:** project renamed from `dotclaude` to `dotbabel` to position the
  toolkit as model-agnostic governance for any agentic CLI (Claude Code,
  Codex, Gemini, Copilot).
  - npm package: `@dotclaude/dotclaude` → `@dotbabel/dotbabel`
  - all 15 CLI binaries renamed: `dotclaude-*` → `dotbabel-*`
  - schema `$id` host: `dotclaude.dev` → `dotbabel.dev`
  - directory: `plugins/dotclaude/` → `plugins/dotbabel/`
  - spec IDs: `dotclaude-core` → `dotbabel-core`, `dotclaude-agents` → `dotbabel-agents`
  - canonical config dir: `~/.config/dotbabel/`
  - canonical cache dir: `~/.cache/dotbabel/`
  - canonical env-var prefix: `DOTBABEL_*` (12 vars; see Migration below)

### Migration

A read-fallback compatibility layer keeps v1.x setups working through the
2.x release window. **All compat shims are removed in 3.0.0.**

- `~/.config/dotclaude/` and `~/.cache/dotclaude/` are still honored when
  the canonical paths are absent. A one-time `process.emitWarning` with code
  `DOTBABEL_LEGACY_CONFIG` (or `_CACHE`) fires per process on fallback.
- All 12 `DOTCLAUDE_*` env vars fall back when the corresponding `DOTBABEL_*`
  is unset. A one-time warning with code `DOTBABEL_LEGACY_ENV` fires per
  process per variable.
- Writes always target canonical paths; legacy files are never mutated.
- The persisted handoff env file (`<configDir>/handoff.env`) is now written
  with `export DOTBABEL_HANDOFF_REPO=...`.

To migrate cleanly:

1. `npm install -g @dotbabel/dotbabel` (uninstall `@dotclaude/dotclaude` if needed).
2. `dotbabel bootstrap` to update `~/.claude/` symlinks.
3. Rename `DOTCLAUDE_*` env vars in your shell rc files to `DOTBABEL_*`.
4. (Optional) `mv ~/.config/dotclaude ~/.config/dotbabel` to silence the
   `DOTBABEL_LEGACY_CONFIG` warning.

See `docs/upgrade-guide.md` for the full migration walkthrough.

## [1.3.0](https://github.com/kaiohenricunha/dotbabel/compare/v1.2.1...v1.3.0) (2026-05-04)

### Added

- **handoff:** support deliberate-label aliases in pull/fetch resolution ([#158](https://github.com/kaiohenricunha/dotbabel/issues/158)) ([81c9a15](https://github.com/kaiohenricunha/dotbabel/commit/81c9a15b8e8c7d83a601e8c71acb3cc9f43a0bd1))

### Fixed

- **audits:** fix markdownlint + prettier violations in alias-resolver memo ([5ac4541](https://github.com/kaiohenricunha/dotbabel/commit/5ac4541e3e983cc90aa29b016dd73368a7787d6f))
- **handoff:** unify claude alias scans + case-fold wrapper latest dispatch ([e7be150](https://github.com/kaiohenricunha/dotbabel/commit/e7be1502ccaaeed6129601d08d6959e6f8e68570))

### Documentation

- **audits:** bank [#158](https://github.com/kaiohenricunha/dotbabel/issues/158) alias-resolver investigation memo (deliberate-label scope) ([cd153b6](https://github.com/kaiohenricunha/dotbabel/commit/cd153b6b03f29fa567cea957418fad36ac116c1d))

## [1.2.1](https://github.com/kaiohenricunha/dotbabel/compare/v1.2.0...v1.2.1) (2026-05-01)

### Fixed

- **handoff:** tighten cell-27 test to lock first-arg-wins ([#155](https://github.com/kaiohenricunha/dotbabel/issues/155)) ([250c7d2](https://github.com/kaiohenricunha/dotbabel/commit/250c7d2c30f11435a4b9247dec67e8fb00ee6b98))

### Documentation

- **contributing:** document PR merge strategy convention ([#165](https://github.com/kaiohenricunha/dotbabel/issues/165)) ([897cb02](https://github.com/kaiohenricunha/dotbabel/commit/897cb02a256f971a25ca962e48450de92c03bdb2))
- **handoff:** document latest host-scoping precedence ([1f175fc](https://github.com/kaiohenricunha/dotbabel/commit/1f175fc7ce6548048d62a056257329cfe32fdad1))

## [1.2.0](https://github.com/kaiohenricunha/dotbabel/compare/v1.1.1...v1.2.0) (2026-05-01)

### Added

- **handoff:** forbid fabrication when binary execution fails ([#157](https://github.com/kaiohenricunha/dotbabel/issues/157)) ([85d927d](https://github.com/kaiohenricunha/dotbabel/commit/85d927dd68db8dda481bf48b49c59d8ddf5546ac))

### Fixed

- **drift-test:** loosen report heuristic to match cross-word phrasing ([9efb93c](https://github.com/kaiohenricunha/dotbabel/commit/9efb93cb7ae503392c028bec8dae433e776de0b2))

## [1.1.1](https://github.com/kaiohenricunha/dotbabel/compare/v1.1.0...v1.1.1) (2026-04-30)

### Fixed

- **handoff:** harmonize empty-state placeholder wording ([#159](https://github.com/kaiohenricunha/dotbabel/issues/159)) ([#161](https://github.com/kaiohenricunha/dotbabel/issues/161)) ([c871fc2](https://github.com/kaiohenricunha/dotbabel/commit/c871fc21506623093c7111b836b5a80db150cb7e))
- **ci:** make post-bump regen output prettier-compliant ([#156](https://github.com/kaiohenricunha/dotbabel/issues/156)) ([#161](https://github.com/kaiohenricunha/dotbabel/issues/161)) ([c871fc2](https://github.com/kaiohenricunha/dotbabel/commit/c871fc21506623093c7111b836b5a80db150cb7e))
- **handoff:** add codex rollout format-drift bats coverage ([#160](https://github.com/kaiohenricunha/dotbabel/issues/160)) ([#161](https://github.com/kaiohenricunha/dotbabel/issues/161)) ([c871fc2](https://github.com/kaiohenricunha/dotbabel/commit/c871fc21506623093c7111b836b5a80db150cb7e))

## [1.1.0](https://github.com/kaiohenricunha/dotbabel/compare/v1.0.1...v1.1.0) (2026-04-30)

### Added

- **commands:** add /create-experiment sandboxed exploration skill ([#150](https://github.com/kaiohenricunha/dotbabel/issues/150)) ([4bbf8a2](https://github.com/kaiohenricunha/dotbabel/commit/4bbf8a209630a6e21b2f864b6756b055189974cc))

### Fixed

- **handoff:** reject empty `--from` value ([#147](https://github.com/kaiohenricunha/dotbabel/issues/147)) ([#154](https://github.com/kaiohenricunha/dotbabel/issues/154)) ([c02c13e](https://github.com/kaiohenricunha/dotbabel/commit/c02c13ef810066d5f1756b7767138da04e13ae96))
- **handoff:** `pull -o <path>` stdout contract per §5.5.1 OPS-2 ([#148](https://github.com/kaiohenricunha/dotbabel/issues/148)) ([#154](https://github.com/kaiohenricunha/dotbabel/issues/154)) ([c02c13e](https://github.com/kaiohenricunha/dotbabel/commit/c02c13ef810066d5f1756b7767138da04e13ae96))
- **handoff:** document resolver session-validity rules in spec §4.1.1 ([#149](https://github.com/kaiohenricunha/dotbabel/issues/149)) ([#154](https://github.com/kaiohenricunha/dotbabel/issues/154)) ([c02c13e](https://github.com/kaiohenricunha/dotbabel/commit/c02c13ef810066d5f1756b7767138da04e13ae96))
- **handoff:** `pull` requires explicit `<query>` per spec §5.2.1. Previous versions silently defaulted to `latest` when the positional was omitted, which contradicted the spec. The fix removes the implicit default; users who relied on bare `dotclaude handoff pull` as shorthand must now type `dotclaude handoff pull latest`. Narrowing behavior of `pull latest` (host detection via env vars + `--from`) is unchanged. ([#152](https://github.com/kaiohenricunha/dotbabel/issues/152)) ([#154](https://github.com/kaiohenricunha/dotbabel/issues/154)) ([c02c13e](https://github.com/kaiohenricunha/dotbabel/commit/c02c13ef810066d5f1756b7767138da04e13ae96))

### Documentation

- **audit:** append Pair B engagement-depth note to Phase 4 result block ([#153](https://github.com/kaiohenricunha/dotbabel/issues/153)) ([42c1fae](https://github.com/kaiohenricunha/dotbabel/commit/42c1faee15b59e012c70be47aa0d9bfa9f1501a3))

## [1.0.1](https://github.com/kaiohenricunha/dotbabel/compare/v1.0.0...v1.0.1) (2026-04-29)

### Fixed

- re-baseline release-please at v1.0.0 ([#142](https://github.com/kaiohenricunha/dotbabel/issues/142)) ([78e2619](https://github.com/kaiohenricunha/dotbabel/commit/78e2619235619ad727513f6e3681530d039563cc))

## [1.0.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.11.0...v1.0.0) (2026-04-29)

The v1.0 stable cut of `@dotclaude/dotclaude`. Locks the handoff v2
surface, fixes the busybox/Alpine substrate crash, formalizes spec
templates that the v0.11.0 binary already implemented, and adds a CI
gate that prevents the release-pipeline drift behind #133/#134.

See [docs/migrations/v1.0.md](./docs/migrations/v1.0.md) for the full
verb-rename mapping and migration examples.

### ⚠ BREAKING CHANGES

- **handoff:** verb-rename surface redesign (#87, lands in this release). The pre-v1 `pull` verb (which fetched from the remote) and `--to <cli>` flag are gone. `--from <cli>` is now mandatory whenever the verb cannot infer the producing CLI from the input. Per spec §6.5 migration table:

  | Before (≤0.10.x)                          | After (v1.0)                                                |
  | ----------------------------------------- | ----------------------------------------------------------- |
  | `dotclaude handoff pull <id>`             | `dotclaude handoff fetch <id>`                              |
  | `dotclaude handoff pull <id> --to claude` | `dotclaude handoff fetch <id>` (consumer CLI is implicit)   |
  | `dotclaude handoff push <id>`             | `dotclaude handoff push <id>` (unchanged when `<id>` given) |
  | `dotclaude handoff push --from <cli>`     | unchanged; `--from` required when `<id>` is omitted         |
  | (no equivalent)                           | `dotclaude handoff pull <id>` — render a **local** session  |

  `pull` is now strictly local — it renders a local session as a
  `<handoff>` block, summary markdown (`--summary`), or a file
  (`-o <path>`). `fetch` is the remote-transport verb. `--to` is
  removed; the consumer CLI is always implicit (it's the one running
  the binary).

### Added

- **handoff:** `pull <id>` local rendering with `--summary` and `-o <path|auto|->` modes (#87). Stream isolation per spec §5.5.1 OPS-2: `<handoff>`/summary/path on stdout, progress on stderr.
- **handoff:** `prune --older-than <30d|6m|1y|YYYY-MM-DD>` for transport cleanup, with `--dry-run` and `--yes`.
- **handoff:** `--tag <label>` (multi-valued on push, single-value filter on `list --remote --tag`) and `list --remote --tags` histogram.
- **handoff:** push/fetch auto-run preflight on first use within a 5-minute window; `--verify` forces re-run. `doctor` verb unchanged.
- **handoff:** `<handoff>` block surfaces source CLI's customTitle / thread_name when present; resolver accepts named aliases on codex.
- **release:** `.github/workflows/release-gate.yml` enforces version-tag alignment on every PR to main and runs the published-tarball-vs-source diff on release PRs (#134).
- **docs:** `docs/migrations/v1.0.md` migration guide; spec §5.3.2 amended to formalize the narrowed `no <cli> session matches` form when `--from` is set.

### Fixed

- **handoff #129:** `pick_newest()` no longer crashes on busybox/Alpine. The runtime `||` fallback chain (find -printf → stat -f → stat -c) is replaced by a single probe at script init that detects GNU/BSD/posix substrates and selects one deterministic path. Fixed in #139.
- **handoff #135:** pull no-match stderr no longer double-prefixes `dotclaude-handoff: handoff-resolve: ...`. Fixed in #140 — the resolver script's prefix is stripped before the binary's own prefix is added.
- **handoff #130:** `js-yaml` is now lazy-loaded inside `build-index.mjs`. `dotclaude handoff --help` and other handoff commands no longer require `js-yaml` to be installed. Fixed in #140.

### Documentation

- **handoff #131 — system requirements (out of scope: sh-only environments).** The handoff toolchain requires `bash` 4+, `jq` 1.6+, `perl` 5.x, `git` 2.x, and GNU coreutils on the path. POSIX `sh`-only environments (e.g. minimal Alpine without bash installed) are unsupported. Substrate detection at script init handles GNU vs BSD vs busybox coreutils transparently as long as bash is present. See [docs/handoff-guide.md](./docs/handoff-guide.md#system-requirements).

- **handoff #132 — known property: branch namespace is host-agnostic.** Handoff branches are named `handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>` (no hostname segment). If you fetch a session on machine A, edit it locally, then push from machine B against the same short-uuid, the second push **overwrites** the first. The short-uuid collision check (`metadata.json:hostname`) detects cross-host overwrites and exits 2 unless `--force-collision` is set, but the branch namespace itself is host-agnostic by design. See [docs/handoff-guide.md](./docs/handoff-guide.md#cross-host-collision-semantics).

- **handoff CP-1 — Copilot slash-handler does not pass `--summary` / `-o` flags through.** `/handoff pull latest --summary` and `/handoff pull latest -o <path>` exit 64 inside the Copilot CLI before the binary is invoked (the Copilot slash parser strips flag-prefixed arguments). Mitigation: invoke the bare binary, e.g. `!dotclaude handoff pull latest --summary`. The Claude Code and Codex slash paths are unaffected.

- **handoff CX-1 — progress messages go to stderr per spec §5.5.1 OPS-2.** When capturing the first line of `pull <id>` output (e.g. inside the Codex `!`-shell which displays the interleaved combined stream), redirect stderr explicitly: `dotclaude handoff pull <id> 2>/dev/null | head -1`. The `<handoff>` block, summary markdown, and `-o`-target path are stdout; the `latest <cli> session: <id>` and `using --from <cli> override` lines are stderr.

## [0.11.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.10.0...v0.11.0) (2026-04-20)

### ⚠ BREAKING CHANGES

- **handoff:** self-bootstrap push — drop init ceremony and schema pin ([#80](https://github.com/kaiohenricunha/dotbabel/issues/80))

### Added

- **handoff:** self-bootstrap push — drop init ceremony and schema pin ([#80](https://github.com/kaiohenricunha/dotbabel/issues/80)) ([ab02686](https://github.com/kaiohenricunha/dotbabel/commit/ab026867a2b3665d413961cb1f9faf6ae8cecc85))

## [0.10.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.9.0...v0.10.0) (2026-04-20)

### ⚠ BREAKING CHANGES

- **handoff:** every `dotclaude handoff push` now requires a one-time `dotclaude handoff init` against $DOTCLAUDE_HANDOFF_REPO. Existing v1 branches remain readable; writes always emit the new v2 shape. Migrate script lands as a follow-up (plan PR C). Migration is one command: `dotclaude handoff init`.

### Added

- **handoff:** v2 store taxonomy + schema enforcement + init ([#73](https://github.com/kaiohenricunha/dotbabel/issues/73)) ([6da64bb](https://github.com/kaiohenricunha/dotbabel/commit/6da64bb80f7e25d489d1ee92bef2416d3a1674a2))

## [0.9.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.8.0...v0.9.0) (2026-04-20)

### ⚠ BREAKING CHANGES

- **handoff:** `--via github`, `--via gist-token`, `--via git-fallback`, `DOTCLAUDE_GH_TOKEN`, and the `references/transport-github.md` file are removed. Migration is `s/ --via git-fallback//g` across any script that called `dotclaude handoff push|pull --via git-fallback`; gist users move to a private git repo (`gh repo create handoff-store --private` + `export DOTCLAUDE_HANDOFF_REPO=git@github.com:<user>/handoff-store.git`) and delete leftover gists with `gh gist list` + `gh gist delete <id>`.

### Added

- **handoff:** promote doctor, remote-list, search into the binary ([#71](https://github.com/kaiohenricunha/dotbabel/issues/71)) ([7ea0883](https://github.com/kaiohenricunha/dotbabel/commit/7ea08833104ebe89292e4b280468670fbb08bff0))
- **handoff:** remove gist transports, drop --via flag ([#68](https://github.com/kaiohenricunha/dotbabel/issues/68)) ([9aec0dc](https://github.com/kaiohenricunha/dotbabel/commit/9aec0dc0902a58831898ad34ccda97be06250b3f))

### Changed

- **handoff:** rename git-fallback internals to remote ([#70](https://github.com/kaiohenricunha/dotbabel/issues/70)) ([fc8fbf7](https://github.com/kaiohenricunha/dotbabel/commit/fc8fbf773d2e2380d4b9e7097d41a47c53f86b9f))

### Documentation

- **handoff:** slim SKILL.md to a thin wrapper around the binary ([#72](https://github.com/kaiohenricunha/dotbabel/issues/72)) ([fee18d7](https://github.com/kaiohenricunha/dotbabel/commit/fee18d7d3ed86e3ced9c6257ff38791c4a74c135))

## [0.8.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.7.0...v0.8.0) (2026-04-19)

### ⚠ BREAKING CHANGES

- **handoff:** `push <cli> <query>` and `pull <cli> <handle>` now exit 64 with a migration message pointing at `--from`. Power-user subs (resolve/describe/digest/file) keep their explicit `<cli> <id>`.

### Added

- **handoff:** drop &lt;cli&gt; positional from push/pull ([#66](https://github.com/kaiohenricunha/dotbabel/issues/66)) ([a172e0e](https://github.com/kaiohenricunha/dotbabel/commit/a172e0e3b736094c43b80047ed2e217ed30a8301))

### Fixed

- **test:** avoid bats $output capture for 10k-session stress test ([#63](https://github.com/kaiohenricunha/dotbabel/issues/63)) ([e1145b0](https://github.com/kaiohenricunha/dotbabel/commit/e1145b016e7a7266f133178084d13d04126d86b0))

### Documentation

- add Copilot instructions, review config, and AGENTS.md ([#65](https://github.com/kaiohenricunha/dotbabel/issues/65)) ([eb1aca4](https://github.com/kaiohenricunha/dotbabel/commit/eb1aca425b46467b64162c3b5c8ab1d4dcb9280c))

## [0.7.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.6.0...v0.7.0) (2026-04-19)

### Added

- **handoff:** shell-scripts-first refactor + dotclaude-handoff binary ([#58](https://github.com/kaiohenricunha/dotbabel/issues/58)) ([176cb9d](https://github.com/kaiohenricunha/dotbabel/commit/176cb9dd9a0c1ba5362bd783604343aaa4815b19))

## [0.6.0](https://github.com/kaiohenricunha/dotbabel/compare/v0.5.0...v0.6.0) (2026-04-18)

### Added

- /pre-pr and /review-prs commands + CLAUDE.md rule refinements ([#51](https://github.com/kaiohenricunha/dotbabel/issues/51)) ([4e300ca](https://github.com/kaiohenricunha/dotbabel/commit/4e300ca399555d9b2fc8f018d30fe55fcbe977f4))
- **ci:** automate semantic versioning with release-please ([#52](https://github.com/kaiohenricunha/dotbabel/issues/52)) ([67e7949](https://github.com/kaiohenricunha/dotbabel/commit/67e79491a190c6dfa51188de55daf80169be7436))

### Fixed

- **ci:** allow release-please CHANGELOG formatting in lint checks ([#55](https://github.com/kaiohenricunha/dotbabel/issues/55)) ([7b0c048](https://github.com/kaiohenricunha/dotbabel/commit/7b0c0484425b508d0e15373725f3710963adadca))
- **ci:** fix release-please config — drop ### prefix, add include-component-in-tag: false ([#54](https://github.com/kaiohenricunha/dotbabel/issues/54)) ([e7ae3e3](https://github.com/kaiohenricunha/dotbabel/commit/e7ae3e3495f8fd76dedd47213d46458bc6211d28))
- remove squadranks vocabulary from project-agnostic surface ([#57](https://github.com/kaiohenricunha/dotbabel/issues/57)) ([59b5c63](https://github.com/kaiohenricunha/dotbabel/commit/59b5c6314861ad45150f5fa1c9087c057fc39175))

### Documentation

- close v0.4-v0.5 coverage gaps + automate version stamps ([#56](https://github.com/kaiohenricunha/dotbabel/issues/56)) ([6e121c7](https://github.com/kaiohenricunha/dotbabel/commit/6e121c7721b5a504fe84cf65ea0539c2cf0f3f4e))

## [Unreleased]

### BREAKING

- **`handoff push`/`pull`**: the `<cli>` positional is removed. The
  resolver already auto-detects across all three roots (claude,
  copilot, codex); forcing the user to state the source CLI was
  busywork. Migration:
  - `dotclaude-handoff push claude <q>` → `dotclaude-handoff push <q>`
    (or `... push <q> --from claude` to force a root).
  - `dotclaude-handoff pull claude <h>` → `dotclaude-handoff pull <h>`
    (or `... pull <h> --from claude`).
  - Power-user subs (`resolve`, `describe`, `digest`, `file`) keep
    their explicit `<cli> <id>` — scripting entry points unchanged.

  The binary now exits 64 on the removed form with an actionable
  message pointing at `--from` and this CHANGELOG. Bare
  `dotclaude-handoff` (no positionals) now executes `push` (host's
  latest session), aligning the binary with SKILL.md's five-form
  surface. Help still lives behind `--help`.

### Added

- **`--from <cli>` flag** on `push` / `pull` / bare `<query>`.
  Narrows auto-detection to a single root. Useful for scripting and
  for resolving short-UUID collisions across roots.
- **`detectHost()` env-probe routing.** The binary best-effort
  identifies the agentic CLI it is running inside via `CLAUDECODE`,
  `CLAUDE_CODE_SSE_PORT`, and `CODEX_*` / `COPILOT_*` / `GITHUB_COPILOT_*`
  prefix scans. All signals are labelled UNCONFIRMED in the source —
  false positives are cheap (a narrower resolve) and false negatives
  fall back to the union resolver.
- **Honest stderr fallback notes.** Bare `push` (no query) now prints
  one stderr line naming which fallback fired:
  - `no current-session signal in <cli>, using latest <cli> session: <short>`
    — host was detected, narrowed to its root.
  - `using --from <cli> override, latest session: <short>` — `--from`
    was explicit, host was not detected or differed.
  - `host not detected, using latest across all clis: <short>` —
    union-resolver fallback.
- **`--to` default is the detected host.** Previously hardcoded to
  `claude`; now matches whichever CLI the binary is running inside
  (falling back to `claude` when undetected).

## [0.5.0] — 2026-04-18

No breaking changes. This release adds cross-machine session handoff via GitHub
Gists, a `docker-engineer` agent, a curl-pipe-bash installer, and a refactored
agent build pipeline.

### Added

- **Cross-machine handoff transport** — `/handoff push`, `pull`, `remote-list`,
  and `doctor` sub-commands let a session started on one machine (Windows/WSL)
  be resumed on another (PopOS / macOS / CI). Default transport uses
  `gh gist`; `--via gist-token` (curl + PAT) and `--via git-fallback` (raw
  git) are documented workarounds for hosts where `gh` is unavailable or
  blocked. Includes a push-side secret-scrubbing pass covering eight token
  patterns, a `handoff-doctor.sh` preflight with per-transport remediation
  blocks, and 80 bats unit tests plus an e2e gist round-trip harness (#46,
  #49).
- **`docker-engineer` agent** — Compose orchestration and runtime ops; covers
  multi-service health, volume binding, network bridge configuration, and
  registry operations (#47).
- **curl-pipe-bash installer** — `curl -sSL .../install.sh | bash` path for
  users who prefer not to use npm. Idempotent; respects `NO_COLOR` (#44).

### Changed

- **Agent build pipeline alignment** — all agents consistently use the
  build-plugin script for template generation; scale-foundation tooling
  refactored to be purely generic (no project-specific references) (#48).

### Documentation

- README surfaces the skills catalog, a quick-taste section, and a revised
  persona framing (quality score raised from 6.1 → 9.6/10 per the README
  assessment) (#45).

## [0.4.0] — 2026-04-17

No breaking changes. This release adds the global-lifecycle CLI
(`dotclaude bootstrap`, `dotclaude sync`), first-class agents, the
taxonomy pipeline (schemas → backfill → search/list/show → build-plugin),
and a broad set of provider and IaC agents.

### Added

- **Global lifecycle CLI** — `dotclaude bootstrap` (set up or refresh
  `~/.claude/`) and `dotclaude sync <pull|status|push>` (update an
  installation). Both are idempotent, support `--json` / `--quiet`
  / `--no-color`, and are registered as subcommands of the umbrella
  `dotclaude` dispatcher alongside the taxonomy commands (#29).
- **First-class agent support** — agents directory, model routing,
  and discovery wired into the plugin (#28). Ships with 21 agents
  across generalist, specialist, and veracity tiers (#40):
  - Kubernetes ecosystem agents + `kubernetes-specialist` skill (#31).
  - AWS, Azure, GCP provider agents + `*-specialist` skills (#32).
  - IaC tool agents (Terraform, Terragrunt, Pulumi, Crossplane) +
    `*-specialist` skills (#33).
  - Generic veracity harness: `data-scientist`, `compliance-auditor`,
    and the `veracity-audit` skill (#41).
- **Taxonomy pipeline** — a four-phase buildout that formalizes the
  skill/agent metadata layer:
  - Phase 1: schemas + index builder + non-breaking CLI (#34).
  - Phase 2: frontmatter backfill + schema tightening (#36).
  - Phase 3: `dotclaude search`, `dotclaude list`, `dotclaude show`
    - governance docs + CI gate (#37).
  - Phase 4: `build-plugin` script + generated plugin templates (#38).
- **Slash commands** — generic `/review-pr` (#22) and `/create-inspection`
  (#23), plus strengthened branch-health gates and mandatory test plans
  in `/review-pr` (#25).
- **Lint pipeline** — `npm run lint` now wires `prettier` and
  `markdownlint-cli2` (#18).

### Changed

- README and CLAUDE.md document the two-path usage model
  (bootstrap vs npm plugin) (#24) and the new `bootstrap` / `sync`
  subcommands (#30).
- CLAUDE.md absorbs the Karpathy behavioral guidelines (#26).
- `dotclaude-agents` spec registered; `.gitignore` cleaned up (#39).
- Agent spec text updated with tier rationale from audit findings (#42).
- CI bumps `actions/upload-artifact` 4.6.2 → 7.0.1 (#13).

### Fixed

- `bootstrap` now links `hooks/` into `~/.claude/hooks/` so
  guard-destructive-git and friends apply globally (#35).
- Patched `js-yaml` prototype pollution (GHSA-mh29-5h37-fv8m) (#27).
- Closed 12 open CodeQL alerts around workflow permissions and
  security (#19).
- Dogfood workflow now uses `PR_ACTOR` (derived from PR author)
  instead of the `GITHUB_ACTOR` builtin, restoring correct bot
  detection (#20, #21).

## [0.3.0] — 2026-04-14

### Breaking

- **Package renamed** from `@kaiohenricunha/harness` → `@dotclaude/dotclaude`.
  Update your `package.json` dependency and all imports.
- **All CLI bins renamed**: `harness-*` → `dotclaude-*` (e.g. `harness-doctor`
  → `dotclaude-doctor`). Update CI workflows, pre-commit hooks, and any scripts
  that invoke them directly.
- **Three env vars renamed**: `HARNESS_DEBUG` → `DOTCLAUDE_DEBUG`,
  `HARNESS_JSON` → `DOTCLAUDE_JSON`, `HARNESS_REPO_ROOT` → `DOTCLAUDE_REPO_ROOT`.
  Note: `HARNESS_CHANGED_FILES` (CI diff input) and `HARNESS_SYNC_SKIP_SECRET_SCAN`
  (sync.sh bypass) are **not** renamed — they remain `HARNESS_*`.
- **Plugin directory** moved from `plugins/harness/` → `plugins/dotclaude/`
  (affects deep imports — use the public barrel `@dotclaude/dotclaude` instead).
- **Spec ID** `harness-core` → `dotclaude-core` (update `Spec ID:` lines in PR
  bodies and any `depends_on_specs` references).

### Changed

- npm scope changed from `@kaiohenricunha` to `@dotclaude` — published under
  the public `dotclaude` npm org.
- Prose and docs de-personalized for a public audience.

## [0.2.0] — 2026-04-14

First public release targeting `npm publish --provenance --access public`.
Productizes the plugin: public Node API barrel, structured-error contract,
umbrella CLI, shell hardening, full bats + vitest coverage, dogfood wiring,
and the docs set consumers need to adopt.

### Added

- **Node API barrel** at `plugins/dotclaude/src/index.mjs` — 24+ named exports
  covering every validator + `ValidationError` + `EXIT_CODES` + `version`.
- **Structured error taxonomy** (`plugins/dotclaude/src/lib/errors.mjs`): every
  validator emits `ValidationError` instances with stable `.code`, `.file`,
  `.pointer`, `.expected`, `.got`, `.hint`, `.category`. Enumerated codes
  (`SPEC_STATUS_INVALID`, `MANIFEST_CHECKSUM_MISMATCH`,
  `COVERAGE_UNCOVERED`, `DRIFT_TEAM_COUNT`, …) are a stable contract —
  renames are breaking.
- **Named `EXIT_CODES`** (`{OK:0, VALIDATION:1, ENV:2, USAGE:64}`) consumed
  by every bin. `64` mirrors BSD `sysexits.h EX_USAGE`.
- **Umbrella `dotclaude` CLI** that dispatches to subcommands:
  `harness validate-specs|validate-skills|check-spec-coverage|check-instruction-drift|detect-drift|doctor|init`.
  Every bin also exists as a standalone — `dotclaude-doctor`, `dotclaude-init`,
  etc.
- **`dotclaude-doctor`** — runs through env, repo, facts, manifest, specs,
  drift, and hook checks and reports `✓/✗/⚠` with exit 0/1/2.
- **`dotclaude-detect-drift`** — wraps `plugins/dotclaude/scripts/detect-branch-drift.mjs`
  so `npx dotclaude-detect-drift` resolves. Fixes the broken
  `plugins/dotclaude/templates/workflows/detect-drift.yml:15` invocation.
- **Universal CLI flags** across every bin: `--help`, `--version`, `--json`,
  `--verbose`, `--no-color`, plus bin-specific flags (`--update`,
  `--project-name`, `--force`, `--target-dir`, …).
- **`--json` output** on every bin and on `validate-settings.sh`, suitable
  for `jq -r '.events[] | …'` CI pipelines.
- **`set -euo pipefail`** across every shipped shell script; ✓/✗/⚠ helpers
  factored into `plugins/dotclaude/scripts/lib/output.sh` and mirrored in
  `src/lib/output.mjs`.
- **Hardened `guard-destructive-git.sh`** — normalizes tab whitespace,
  boundary-anchors `git` tokens, adds blocks for `git branch -D` and
  `git worktree remove --force`, and exposes `BYPASS_DESTRUCTIVE_GIT=1`
  bypass. Exit 2 preserved per Claude Code PreToolUse protocol.
- **`bootstrap.sh --quiet` + `--help`** plus a trailing
  `run 'dotclaude-doctor' to verify install` hint when the bin is on PATH.
- **`sync.sh` secret scan** — literal `_KEY` / `_TOKEN` / `_SECRET` + AWS
  keys + bearer tokens are refused at push time.
  `HARNESS_SYNC_SKIP_SECRET_SCAN=1` is the documented escape hatch.
- **bats suite** at `plugins/dotclaude/tests/bats/` (34 tests) covering every
  hardened shell surface.
- **Coverage gate** — `vitest run --coverage` enforces lines 85 /
  functions 85 / branches 80 / statements 85 via `vitest.config.mjs`.
- **`examples/minimal-consumer/`** — committed post-`dotclaude-init` scaffold.
- **Dogfood**: root `.claude/{settings,skills-manifest}.json`,
  `docs/repo-facts.json`, `docs/specs/dotclaude-core/{spec.json,spec.md}`.
  Every validator exits 0 against the root (see `npm run dogfood`).
- **Docs set**: `LICENSE`, `CHANGELOG.md` (this file), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `docs/{index,quickstart,cli-reference,api-reference,architecture,personas,troubleshooting,upgrade-guide}.md`,
  `docs/adr/`, `plugins/dotclaude/templates/README.md`. README.md and
  `plugins/dotclaude/README.md` rewritten for consumer clarity.
- **Commands** (`.claude/commands/*.md`) get YAML frontmatter matching the
  `skills/*/SKILL.md` schema.

### Changed

- **Public surface** — deep imports from `plugins/dotclaude/src/*.mjs` are no
  longer a supported contract. Use the barrel import.
- **`package.json`** — `"main"` now points at the real barrel; `"exports"`
  field added; three new `"bin"` entries; `"files"` covers
  `plugins/dotclaude/scripts/` so `refresh-worktrees.sh`,
  `detect-branch-drift.mjs`, and `auto-update-manifest.mjs` ship in the
  tarball; version bumped to `0.2.0`.

### Breaking changes (for early adopters of 0.1.x)

- Validator errors are `ValidationError` instances, not strings. Existing
  CI pipelines that `grep` stderr continue to work because
  `ValidationError.prototype.toString()` preserves the
  `"<file>: <message>"` format; pipelines that consume `--json` get the
  structured payload.
- Deep imports (`import { … } from "@dotclaude/dotclaude/src/validate-specs.mjs"`)
  are no longer a supported contract — use the barrel.

## [0.1.0] — 2026-04-13

Retroactive entry. Initial plugin skeleton: spec-harness library, five
validators, template tree, hook, and `test_validate_settings.sh`. Never
published to npm — the first published version is 0.2.0.

## Roadmap

- Marketplace submission for the Claude Code plugin listing.
- `dotclaude upgrade` subcommand to migrate consumer repos across versions.
- `.d.ts` shipping for stronger type inference (via hand-authored declarations
  — TypeScript migration is out of scope per ADR-0002).
