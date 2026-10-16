# Sources and provenance

## Status

The guidance in this skill is **independently authored** and is marked `maturity: draft`. No
native speaker of any of the seven languages has reviewed it yet. On 2026-10-15 each locale file
and its test fixtures were independently fact-checked by a separate model reviewer, and the errors it
found were corrected. That is a check for obvious mistakes, not a substitute for a native-speaking
editor. Promote the skill to `validated`
only after at least one native-speaking editor has reviewed each locale file. Until then, the
"Verify before ruling" section of each file is the honest boundary of what it knows.

Nothing is vendored or copied from another project. No upstream license obligation attaches to
this directory. If upstream text is ever copied, add its license notice here first.

## What informed the work

| Source                                                                                                                          | What it is                                                                                                                                            | Licence                                                                     | How it was used                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [i18nstack](https://github.com/i18n-agent/i18nstack) by i18nagent.ai, the `localize-*` skills and `/i18n-review`                | Skills that guide an agent in **producing** translations for 46 languages, plus CLI tools for conversion, pseudo-localization, and catalog validation | MIT, Copyright (c) 2026 i18nagent.ai (the `LICENSE` file in the repository) | Read on 2026-10-15 for topic coverage only: what register, script, punctuation, plural, and false-friend questions a localization guide must ask. Its focus is generation, not review. No text, table, or example was reused |
| [Natural Portuguese Writer](https://mcpmarket.com/tools/skills/natural-portuguese-writer), listed on MCP Market, author `dvcrn` | A skill that rewrites Portuguese text to sound human                                                                                                  | No licence is stated on the listing                                         | Read as a description only. Its method is to add spoken reductions and regional fillers, which this skill rejects as casualization (see the rubric). Used as a counter-example. Nothing was reused                           |
| The authoritative references listed below                                                                                       | Dictionaries, academy publications, and standards                                                                                                     | Each its own                                                                | Named so a reviewer can verify a point. Not quoted                                                                                                                                                                           |

How the upstream material was read: the repository page, the licence file, and the raw
`localize-pt`, `localize-ar`, and `localize-id` files were read through a web fetch that returned
summaries, not through a line-by-line audit. The tools were not installed or run. Treat the notes
below as impressions to confirm, not as findings about the upstream project.

- The upstream guides are written for generating translations, and many rules are stated as
  absolutes, with severity scores and prohibitions. In language, usage varies, so this skill
  separates an error from a preference, attaches a confidence level, and keeps contested points
  in a "Verify before ruling" list.
- The upstream guides have no review output contract. This skill defines one, and ships a
  checker for it.

## Evaluated for optional integration

The first release is self-contained. These were considered and not adopted.

| Tool                                              | What it would add                                        | Cost                                                                                                                               | Decision                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| i18nstack CLI tools (`i18n-validate`, and others) | Placeholder and key parity across a whole locale catalog | An npm install, a second toolchain, a wider scope than editorial review                                                            | Not adopted. `scripts/check-review.mjs preserve` covers the protected-token check for a single revision. A project that needs catalog-wide parity can run the upstream tool beside this skill |
| LanguageTool (open source)                        | Automatic `mechanics` findings (spelling, agreement)     | A Java runtime or a service, and rule quality that differs by language, with some of these languages covered less well than others | Not adopted. It does not judge naturalness, which is the point of this skill. Worth a later opt-in                                                                                            |
| Spelling dictionaries (Hunspell, CSpell)          | Cheap spelling checks                                    | A dictionary per language and variant                                                                                              | Not adopted. Spelling is not the core of the review                                                                                                                                           |
| A paid translation or style API, or an MCP server | A second opinion                                         | Network, cost, and sending text to a third party                                                                                   | Rejected for this scope. Review text may be private                                                                                                                                           |
| Machine-readable CLDR data                        | Authoritative plural categories per language             | A data file to keep current                                                                                                        | Not bundled. The locale files name the categories that matter                                                                                                                                 |

## Where to verify a point

Use these to check a claim in a locale file. They are named, not reproduced.

- **English.** Chicago Manual of Style; Merriam-Webster and Oxford dictionaries; the Microsoft
  Writing Style Guide; the Google developer documentation style guide.
- **Brazilian Portuguese.** The Vocabulário Ortográfico da Língua Portuguesa (VOLP) of the
  Academia Brasileira de Letras; the Acordo Ortográfico de 1990; the Manual de Redação of a
  large Brazilian newspaper; the Microsoft Style Guide for Portuguese (Brazil).
- **Spanish.** The Real Academia Española: Diccionario de la lengua española, Diccionario
  panhispánico de dudas, and Ortografía de la lengua española (2010); Fundéu; the Microsoft
  Style Guide for Spanish.
- **French.** The Académie française dictionary; the Banque de dépannage linguistique and the
  Grand dictionnaire terminologique of the Office québécois de la langue française; the
  Imprimerie nationale typographic lexicon.
- **German.** The Duden; the official rules of the Rat für deutsche Rechtschreibung; the
  Microsoft Sprachportal.
- **Arabic.** The Arabic language academies (Cairo, Damascus, Amman, Baghdad); the UN Arabic
  style notes; Unicode Standard Annex #9 (bidirectional algorithm); the W3C Arabic Layout
  Requirements; CLDR plural rules for Arabic.
- **Indonesian.** The Kamus Besar Bahasa Indonesia (KBBI) and the spelling guidelines of the
  Badan Pengembangan dan Pembinaan Bahasa; Tata Bahasa Baku Bahasa Indonesia; the Microsoft
  Style Guide for Indonesian.

## Keeping it honest

- Every locale file has a "Verify before ruling" section. Move a point out of it only when a
  native-speaking editor or an authoritative reference confirms it.
- Examples are illustrative sentences written for this skill. They are not quotations.
- If a rule would be wrong in a region, a register, or a house style, it does not belong in
  "What reads as native". Put it under "Verify before ruling".
