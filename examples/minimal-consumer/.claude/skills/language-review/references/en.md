# English (en)

Reference for `en`, with `en-US` and `en-GB` conventions. Read the rubric first. This file holds
what is specific to English.

## Scope and variants

Review against the declared variant. When none is given, assume `en-US`, unless spelling or
vocabulary shows `en-GB`. Other Englishes (`en-AU`, `en-CA`, `en-IN`, `en-ZA`, and more) have
their own conventions. They are close to `en-GB` in many respects, and `en-CA` mixes US and UK
habits. Do not "correct" them toward US or UK norms. Ask for the house style, or flag only
inconsistency.

| Area             | `en-US`                                                        | `en-GB`                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spelling         | color, center, analyze, gray, license (noun and verb), program | colour, centre, analyse, grey, licence (noun) and license (verb), programme (non-software). Both "-ise" and the Oxford "-ize" occur (organise, organize), but "analyse" is never "analyze" |
| Vocabulary       | fall, apartment, truck, elevator, trash, vacation, zip code    | autumn, flat, lorry, lift, rubbish, holiday, postcode                                                                                                                                      |
| Collective nouns | usually singular: "the team is"                                | singular or plural: "the team are"                                                                                                                                                         |
| Past participle  | "gotten" and "got" both occur                                  | "got"; "gotten" reads as an Americanism                                                                                                                                                    |
| Dates            | month/day/year: 10/05/2026 is October 5                        | day/month/year: 10/05/2026 is 10 May                                                                                                                                                       |
| Quotation marks  | double first; commas and periods inside                        | single first is common; punctuation placed by logic                                                                                                                                        |

These rows are tendencies, not divisions: "got" and "autumn" are also normal in the US. Flag a row
only when the variant is declared or the text mixes the two. Write the month as a word wherever a
date could be misread.

## Register and address

English has no formal "you". Register comes from word choice, sentence length, directness, and
contractions.

- **Contractions** are normal in UI copy, documentation, and friendly writing. Many legal,
  academic, and institutional texts avoid them. Avoid switching without reason inside one passage. Do not add or
  remove contractions to "fix" tone unless the text is inconsistent or the register is wrong.
- **Latinate versus plain words** carry register: "ascertain, commence, utilize" against "find
  out, start, use". In UI and instructions, plain words are the default. In a contract, the
  formal word may be the right one.
- **Politeness.** How often to say "please" is a house-style decision. An imperative is polite in
  instructions ("Enter your email"), and repeated "please" can become noise.
- **Error and warning copy** says what happened and what to do, without blaming the reader.
  "You entered an invalid date" becomes "That date is not valid. Enter it as MM/DD/YYYY." The
  accepted format comes from the product, not from the reviewer.
- **Address.** "You" for the reader, "we" for the organization, "users" in reference material.
  Keep one point of view within a text.
- **Singular "they"** is standard in current usage. Do not change it to "he or she".

## What reads as native

- **Verbs over nominalizations.** "We analyzed the data" over "We carried out an analysis of the
  data". Keep the nominal form when it is the standard term or the subject needs it.
- **Concrete subjects and short distance between subject and verb.** Put the actor first and
  new information late.
- **Collocations.** make a decision, a mistake, a difference; do research, the dishes, a favor;
  take a break, a look (take a decision is British); heavy rain, strong coffee, fast food.
- **Prepositions.** depend on, different from (all varieties; "different to" also occurs in the UK, "different than"
  in the US), interested in,
  responsible for. "Discuss", "emphasize", and "enter" take no preposition before their object.
- **Countable and uncountable.** information, advice, feedback, equipment, software, and research
  are uncountable: "a piece of advice", "much information".
- **Parallel structure** in lists, headings, and button labels. Verb-first labels ("Save",
  "Add item") next to noun labels ("Settings") need a deliberate pattern.
- **Phrasal verbs** are right for plain speech ("set up", "log in"). Note the noun or adjective
  form is one word: setup, login.
- **Rhythm.** A text where every sentence has the same length and shape reads as flat.

## Transfer errors and calques

Look for the influence of the writer's first language. Common patterns:

- **Romance-language influence.** "I am agree", "I have 30 years", "do a
  photo", "actually" for "currently", "eventually" for "possibly", "assist" for "attend",
  "pretend" for "intend", "sensible" for "sensitive".
- **German or Dutch influence.** Verb placed last in a main clause; "I will make it until
  Friday"; "since three years" for "for three years".
- **Article patterns.** Missing articles from speakers of languages without them ("I opened file"),
  and an added "the" before general nouns ("the life is short").
- **Frequent slips.** "informations", "advices", "depends of", "in the other hand", "discuss
  about", "explain me", "return back", "emphasize on".
- **Regional business English.** "Revert" for "reply", "do the needful", "prepone", and "kindly"
  as a stock opener are standard in some regions and read oddly elsewhere. Flag as `regional-fit`
  with `medium` confidence, only when a stated or evident audience lies outside the regions where
  the phrase is standard. With no stated audience, leave it.
- **Inflated or stock phrases.** "in order to" for "to", "due to the fact that" for "because",
  "at this point in time" for "now", "prior to" for "before", "utilize" for "use". Plain words
  usually win in UI and documentation. In legal text they may be deliberate.

## Orthography, punctuation and typography

- **Serial comma.** Both are in use. Flag inconsistency, not the choice.
- **Hyphenation.** A compound modifier before a noun is usually hyphenated ("a well-known author",
  "an up-to-date list") and open after it ("the author is well known"), except after an "-ly"
  adverb ("a highly regarded author"). Open compound nouns stay open ("data center"). The verb is
  two words (log in, back up, set up). The one-word noun forms (login, backup, setup) are the US
  and technical default; British writing often hyphenates them (log-in, back-up, set-up). Flag
  mixing only.
- **Dashes.** An em dash is unspaced in US style. Spaced en dashes are common in UK style.
- **Capitalization.** Sentence case or title case for headings and UI, by house style. Do not
  switch case styles inside one product.
- **Numbers.** 1,234.56 with a period decimal. Currency symbol before the number ($5, £5). "Per
  cent" and "percent" are both used; flag mixing only.
- **Quotation marks.** Keep straight or curly consistently. A US text puts commas and periods
  inside the closing quotation mark.

## Examples

| Original                                                                               | Suggested                                                    | Why                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| We are in the process of carrying out an analysis of the data.                         | We are analyzing the data.                                   | A nominal phrase in a progressive frame says what one verb says                                                             |
| I am agree with you.                                                                   | I agree with you.                                            | A construction carried over from a Romance language                                                                         |
| Please revert by Friday. (audience: US general readers)                                | Please reply by Friday.                                      | "Revert" for "reply" is regional business English. `regional-fit`, `medium`                                                 |
| We have many informations about it.                                                    | We have a lot of information about it.                       | "Information" is uncountable                                                                                                |
| The team are releasing their update. (US copy)                                         | The team is releasing its update.                            | US usage treats a collective noun as singular. British usage allows the plural                                              |
| You have entered an invalid date.                                                      | That date is not valid. Enter it as MM/DD/YYYY.              | Error copy that blames the reader; say what happened and what to do. The accepted format comes from the product             |
| Due to the fact that the server was down, we utilized the backup in order to continue. | Because the server was down, we used the backup to continue. | Stock phrases with plain equivalents. Keep them in legal text                                                               |
| In today's fast-paced world, remember to back up your files.                           | Remember to back up your files.                              | The opener adds nothing; the instruction stays                                                                              |
| Pick a colour and choose your favorite theme. (en-GB)                                  | Pick a colour and choose your favourite theme.               | American "favorite" in British text. Oxford "-ize" is acceptable, so flag "-ize" only if "-ise" also appears. `consistency` |

## Leave alone

These are not errors. Mention one only when it mixes with its opposite or breaks the house style.

- The serial comma, with or without. Split infinitives. A sentence-final preposition. Starting a
  sentence with "And" or "But".
- Singular "they". "Data is" or "data are". "Which" for a restrictive clause in British writing.
- The passive voice when the actor is unknown or unimportant, or in a methods section.
- Contractions in friendly copy, and their absence in formal copy.
- Both "email" and "e-mail"; "whilst" in formal British writing; "learnt" and "learned".
- A long sentence that reads easily. Judge readability, not length.

## Verify before ruling

State these as questions, with `low` or `medium` confidence.

- Whether a regional phrase ("revert", "do the needful") is acceptable for the audience.
- "Hopefully" as a sentence adverb, "comprised of", "alright", "impact" as a verb, and "less" for
  "fewer". Style guides disagree, so follow the house guide.
- Generic, formulaic patterns (stock openers, triplets, symmetrical "not only... but also"
  frames). Their presence is a signal of emptiness, not proof of origin. Flag the emptiness only.
- The conventions of `en-AU`, `en-CA`, `en-IN`, and `en-ZA` where they differ from both US and UK.
- Whether Oxford "-ize" is acceptable in a British house style. Many UK publishers use it.
