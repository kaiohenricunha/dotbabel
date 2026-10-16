# Editorial rubric

The shared method behind every language review. Language-specific conventions live in the
locale files; this file holds only what holds for all of them. Read it for every review.

## Reading the text

1. **Read it whole first.** Decide what the text is for, who reads it, and in what medium: a
   button, an error message, a manual, a contract clause, a newsletter, a chat reply. The same
   sentence can be right in one and wrong in another.
2. **Fix the target before judging.** Language, region or variant, register, and house terms.
   When the author or the user gave them, use them. When not, infer them from the text and
   say so. Judge against the target, not against how you would write it.
3. **Read as the reader.** Imagine a fluent, educated reader of the target variant who has never
   seen a source text. Where would they slow down, re-read, smile, or lose trust?
4. **Never judge origin.** Stiff, calqued text may come from translation, from a writer working
   in a second language, or from a tool. You cannot tell which, and origin is never a finding.
   The reader's experience is.

## The ten dimensions

For each: what to look for, and what to leave alone.

### Naturalness

The central question: would a native speaker naturally write or say this here? Look for
sentences that are grammatical but nobody would produce: unneeded subjects or articles, heavy
fixed phrases, a noun where the language prefers a verb, a literal order. Leave alone anything
natural that you would simply phrase differently.

### Idiomaticity

Conventional expression versus word-for-word transfer. Look for calques of another language's
idiom, collocations built from the wrong verbs, prepositions chosen by the source language, and
false friends. A calque that has become the standard term (many technical terms did) is not a
finding. Check that an idiom exists before declaring a phrase non-idiomatic.

### Lexical choice

Is the word precise, current, and right for the register? Look for a near-synonym with the wrong
connotation, an archaic or inflated word, a borrowed word where a settled native term exists
(and the reverse: a forced native coinage where the borrowing is what people use), and terms that
drift within one text. Prefer the term the audience actually uses.

### Syntax

Sentence structure that fits the language: word order, clause length, nesting, voice, and how
modifiers attach. Look for stacked relative clauses, passives the language does not favor,
English-style noun chains, and ambiguous attachment. Long sentences are fine when the language
and genre carry them. Judge readability, not length.

### Register and tone

Does the formality, warmth, and directness fit the audience and medium? Look for the wrong
address form, a mix of formal and informal inside one text, officialese in friendly copy, slang
in serious copy, and a tone that blames the reader in an error. Register is a spectrum: name
where the text sits and where it should sit, and change it by the smallest step.

### Fluency and cohesion

How sentences and paragraphs hold together. Look for missing or mechanical connectors, a
pronoun with no clear referent, the same word repeated where the language prefers variation (or
the reverse), abrupt topic jumps, and a rhythm where every sentence has the same shape.

### Cultural and regional fit

Local conventions and the target variant: spelling, vocabulary, date, number, currency and
address formats, forms of politeness, honorifics, and references that do not travel. Flag a text
that mixes variants. Do not flag a variant that matches the target. Do not impose one region's
norm on another.

### Meaning preservation

A suggestion must keep the author's intent, and a translation must keep the source's. Check
that a revision does not add a claim, drop a condition, shift modality (may, must, can), flip
a negation, or change a number. If an improvement needs a change of meaning, report it as a
question to the author, not as an edit.

### Artificial-sounding writing

Formulaic, generic, or over-polished prose: stock openers, vague superlatives, stacks of
abstract nouns, reflexive triplets, hedging on hedging, symmetrical "not only... but also"
frames, signposting that announces what the next sentence says, and a summary that repeats the
paragraph. The signal is emptiness: a sentence that survives deletion without loss. Name the empty phrase,
ask the author for the concrete point, and offer only a shorter version that adds no claim.
Marketing copy, abstracts, and speeches use triplets and framing on purpose, so apply this only when
the effect is emptiness, and report at most two such findings per text. Patterns differ by
language, so use the locale file and do not import English tells. Never say a text was machine-written.

### Clarity and concision

Can the reader understand it faster without losing nuance? Look for padding, doubled words,
buried main clauses, ambiguity, and terms the audience does not know. Do not cut hedges,
qualifications, or politeness that the context needs.

## Deciding whether to flag

Run each candidate through these questions, in order.

1. Is the form standard in the target variant? Then it is not a finding, and never `mechanics`.
   Flag mixing of variants, not the choice of one.
2. Is it objectively wrong: spelling, agreement, punctuation, a wrong word? Flag as `mechanics`.
3. Would a fluent reader stumble? You must be able to say where and why. If not, drop it.
4. Is it only different from how you would write it? Not a finding.
5. Are there several natural options, and the text uses one? Leave it.
6. Does house style decide it? Assume the stated style. If none is stated, leave it.
7. Does the fix cost more than the problem? Rewriting a paragraph to gain a nuance is not worth
   it. Offer the small change, or leave it.
8. Would two competent editors disagree? Then it is at most a `preference`, with `medium`
   confidence. Report it only beside a real finding, and at most two per text. Otherwise put it
   under "Left alone".

If nothing survives, the verdict is `natural`, the findings list is empty, and the report says so.

## Severity and confidence

| Severity     | Use when                                                                                                                   | Example                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `critical`   | The meaning is wrong, offensive, or unsafe; a placeholder or tag is broken; or the text is in a variety its readers reject | A dropped negation; a translated `{count}`                |
| `major`      | A native reader notices at once, and it hurts clarity or credibility                                                       | Slang in a banking error; a calque that changes the sense |
| `minor`      | Visible on a close read; polish                                                                                            | A heavy phrase with a plain equivalent                    |
| `preference` | An acceptable alternative, reported beside a real finding and never alone; the author may keep the original                | A synonym of equal register                               |

| Confidence | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `high`     | An objective error, or a point on which standard references and usage agree   |
| `medium`   | Likely, but it varies by region, register, or house style                     |
| `low`      | A judgment call, or you lack the evidence; **always state what is uncertain** |

Severity says how much it matters. Confidence says how sure you are. A reviewer cannot poll native
speakers, so use `high` only for an objective error or a point that standard references support.
They are independent: a
`critical` finding can be `low` confidence, and then the uncertainty is the first thing the author
should read. A
`critical` or `major` finding at `low` confidence counts as `minor` for the verdict, so a guess cannot
turn a text into `needs-revision`.

## Humanizing is not casualizing

"Make it sound human" is a request for specific, varied, purposeful prose. It is not a request
for informality. Humanizing means: concrete words for vague ones, a verb for a noun chain,
a varied rhythm, no boilerplate, no filler, and the register the reader expects.

Do not add: slang, contractions, spoken reductions, filler words, interjections, emoji, regional
markers, or a friendly tone that the context does not call for. A formal contract clause that
reads stiffly may be stiff correctly. A legal, medical, or financial notice stays formal, and a
children's app stays light. The register ladder is: institutional, formal-professional, neutral
courteous, friendly, casual, colloquial. Move toward the register the audience needs by the smallest change that reaches it, and
never past it. Move only if the text sits on the wrong rung.

## Reviewing a translation

When a source is given, review in two passes.

1. **Fidelity** (`fidelity`). Compare the translation with the source for omissions, additions,
   changed numbers, dates, units, negation, modality, and conditions, and for a term that is
   rendered two ways. Check that every placeholder and tag appears once per source occurrence.
   Rewording, reordering, and splitting a sentence are legitimate when the meaning holds.
2. **Target quality.** Read the translation alone, as if no source existed, and apply the ten
   dimensions. Translationese is the main target-side finding: source word order, source
   idioms, and source punctuation habits in the wrong language.

If the source itself is unclear or wrong, report that as a note and review the target against
the likely intent, with lower confidence. Do not edit the source. When a translation is
better than its source, say nothing about it.

## Structured and marked-up text

- **JSON and YAML.** Review the values, never the keys. Report by key path, and by line when
  you can get it with a search. Keep quoting and escaping as found.
- **ICU MessageFormat.** Keep arguments, keywords, selectors, and `#`. Review the prose of
  each branch as a sentence of its own, with the numbers that branch will show. Check that
  the branch fits every number it covers. Where a placeholder stands for a person or
  an object whose gender or number is unknown, check agreement. Suggest neutral wording rather
  than guessing.
- **Concatenated fragments.** A sentence built from several strings and placeholders cannot be
  judged in pieces, and most languages cannot be built that way. Say so, as a `syntax` finding with
  the reason, and suggest one string with placeholders.
- **HTML and Markdown.** Review the prose between tags and markers. Check that a tag does not
  split a phrase the language needs whole. Keep structure, link targets, and anchors. Do not
  reflow lines.
- **Code.** Leave code blocks and identifiers alone. Comments inside code are prose, and are
  reviewed only when the user asks.
- **UI limits.** Length limits and truncation are real, but you can only judge them when a limit
  is given.

## Grouping and brevity

- Group findings of the same kind into one, and list the other locations.
- Order by severity, then by position.
- One short reason per finding. Say what the reader stumbles on, then why the fix is better.
- For a long text, open with the two or three patterns that recur.
- A short "Left alone" note is useful when a reader might otherwise think something was missed,
  such as a convention that looks odd but is correct.
- Do not pad. A review with two real findings is a good review.

## What this review cannot do

- It cannot hear the text, and it cannot see how mixed-direction or complex-script text renders.
  Check right-to-left layout on screen.
- It does not know a brand voice or a house glossary unless they are given.
- It can be wrong about recent slang, small regions, and fast-moving terminology. Set the
  confidence lower where you have less to go on.
- It is not a certified translation check, and it does not replace a native-speaking editor for
  legal, medical, financial, safety, brand, or published content.
- The bundled helper checks structure and protected tokens. It does not judge language.
