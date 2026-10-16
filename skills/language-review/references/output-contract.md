# Output contract

What a language review returns. The Markdown report is for people. The JSON report is for tools
and CI, and is checked by `scripts/check-review.mjs`. Both carry the same facts.

## Markdown report

```text
Language review · <locale> · <file or "pasted text"> (source: <file or tag>)
Assumed: audience <...> · register <...> · domain <...> · variant <given|assumed>
Verdict: <verdict> — <one sentence>

F1 · <category> · <severity> · <confidence> · <location> (also: <more locations>)
  Original:  <the author's wording>
  Suggested: <the proposed wording>
  Why: <what the reader stumbles on, and why the change is better>
  Unsure: <only for low confidence: what is uncertain>

Left alone: <optional; conventions that look odd but are correct>
Revised version: <only when the user asks for one, for example with --revised>
Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

Rules:

- Quote `Original` and `Suggested` in the target language. Write `Why` and `Unsure` in the
  language the user wrote to you in.
- One finding per pattern. Put repeats in `also:`.
- A natural text gets the header, `Verdict: natural`, and the limits line. No findings.
- The revised version keeps every protected token (see the rules in `SKILL.md`). It goes in the
  reply. It is never written to a file.

## JSON report

Reply with one JSON object and nothing else.

```json
{
  "language": "pt-BR",
  "verdict": "needs-revision",
  "assumptions": {
    "audience": "bank customers",
    "register": "neutral, você",
    "domain": "UI copy"
  },
  "preserve": ["DotBabel"],
  "findings": [
    {
      "id": "F1",
      "location": "transfer.error",
      "locations": ["transfer.error", "cart.error"],
      "original": "Opa, deu ruim na sua transferência!",
      "suggestion": "Não foi possível concluir a transferência.",
      "category": "register",
      "severity": "major",
      "confidence": "high",
      "explanation": "Slang in a banking error undermines trust. The fix lowers informality; it adds none."
    },
    {
      "id": "F2",
      "location": "support.reply",
      "original": "Vou estar encaminhando o seu pedido.",
      "suggestion": "Vou encaminhar seu pedido.",
      "category": "idiom",
      "severity": "minor",
      "confidence": "low",
      "uncertainty": "The construction is widely discouraged, but its origin is debated.",
      "explanation": "The simple future says the same in fewer words."
    }
  ],
  "left_alone": ["Bare infinitives on buttons are the normal convention."],
  "revised": "optional: the full revised text, only when asked",
  "disclaimer": "AI-assisted review. It does not replace a native-speaking editor for high-stakes content."
}
```

A natural text:

```json
{
  "language": "fr",
  "verdict": "natural",
  "findings": [],
  "disclaimer": "AI-assisted review. It does not replace a native-speaking editor for high-stakes content."
}
```

## Field reference

| Field                    | Required   | Meaning                                                                             |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| `language`               | yes        | A BCP 47 tag: `pt-BR`, `es-MX`, `ar`, `id-ID`                                       |
| `verdict`                | yes        | One of the verdicts below. It must follow from the findings                         |
| `findings`               | yes        | An array. Empty when the verdict is `natural`                                       |
| `disclaimer`             | yes        | That this is not a native-speaker validation                                        |
| `assumptions`            | no         | An object of strings: audience, register, domain, variant                           |
| `preserve`               | no         | Fixed terms the suggestions must keep verbatim                                      |
| `left_alone`             | no         | An array of strings: conventions that look odd but are correct                      |
| `revised`                | no         | The full revised text, only on request                                              |
| `findings[].id`          | no         | A short label such as `F1`                                                          |
| `findings[].location`    | no         | `file:line` or a key path                                                           |
| `findings[].locations`   | no         | A non-empty array, for a grouped finding                                            |
| `findings[].original`    | yes        | The author's wording, quoted exactly                                                |
| `findings[].suggestion`  | yes        | The proposed wording. It must differ from `original` and keep every protected token |
| `findings[].category`    | yes        | One of the categories below                                                         |
| `findings[].severity`    | yes        | One of the severities below                                                         |
| `findings[].confidence`  | yes        | One of the confidence levels below                                                  |
| `findings[].explanation` | yes        | Why the change improves the text                                                    |
| `findings[].uncertainty` | when `low` | What is uncertain                                                                   |

## Enumerations

### Categories

| Value              | Dimension                   | Use when                                                         |
| ------------------ | --------------------------- | ---------------------------------------------------------------- |
| `naturalness`      | Naturalness                 | Correct, but not what a native speaker would produce             |
| `idiom`            | Idiomaticity                | A literal transfer or a wrong collocation                        |
| `lexical-choice`   | Lexical choice              | The word is imprecise, dated, inflated, or off-register          |
| `syntax`           | Syntax                      | The structure is unnatural, ambiguous, or hard to parse          |
| `register`         | Register and tone           | The formality or address does not fit the audience               |
| `cohesion`         | Fluency and cohesion        | The text does not flow: connectors, references, rhythm           |
| `regional-fit`     | Cultural and regional fit   | A variant mix, or a convention foreign to the target             |
| `fidelity`         | Meaning preservation        | A translation or revision drifts from the intended meaning       |
| `artificial-style` | Artificial-sounding writing | Formulaic, generic, or over-polished                             |
| `clarity`          | Clarity and concision       | Padding, ambiguity, or a buried point                            |
| `mechanics`        | (supporting)                | An objective spelling, grammar, or punctuation error             |
| `consistency`      | (supporting)                | Terminology, address, or spelling drifts inside the text         |
| `markup`           | (supporting)                | A placeholder or tag is already damaged in the text under review |

### Severities

| Value        | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `critical`   | The meaning is wrong or harmful, a protected token is broken, or the variety is one readers reject          |
| `major`      | A native reader notices at once, and it hurts clarity or credibility                                        |
| `minor`      | Visible on a close read; polish                                                                             |
| `preference` | An acceptable alternative, reported beside a real finding and never alone; the author may keep the original |

### Confidence

| Value    | Meaning                                                                     |
| -------- | --------------------------------------------------------------------------- |
| `high`   | An objective error, or a point on which standard references and usage agree |
| `medium` | Likely, but it varies by region, register, or house style                   |
| `low`    | A judgment call; the finding must state what is uncertain                   |

### Verdicts

| Value            | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `natural`        | No findings. The text is already natural. Acceptable alternatives go in `left_alone`                          |
| `minor-polish`   | No blocking finding, and at least one `minor` finding, or a `critical` or `major` finding at `low` confidence |
| `needs-revision` | At least one `critical` or `major` finding at `medium` or `high` confidence                                   |

## Validation

`scripts/check-review.mjs` checks, with no network and no dependencies:

- the document is an object with `language`, `verdict`, `findings`, and `disclaimer`;
- every finding has `original`, `suggestion`, `explanation`, and an allowed `category`,
  `severity`, and `confidence`;
- `assumptions`, when present, is an object of strings, and `left_alone` is an array of strings;
- a `low` finding has `uncertainty`;
- no `suggestion` equals its `original`;
- the `verdict` follows from the severities and confidences, and a review whose only findings are
  preferences is `natural` with an empty `findings` array;
- each `suggestion` keeps the protected tokens of its `original`: placeholders, ICU syntax, tags,
  code, URLs, identifiers, Markdown structure, and the `preserve` terms.

```bash
node scripts/check-review.mjs validate review.json
node scripts/check-review.mjs preserve --original before.txt --revised after.txt
```

A directional mark (U+200E, U+200F) added next to a Latin token in right-to-left text is a
warning, not a failure, unless it lands inside a placeholder. Added or removed CLDR plural
categories are a failure unless `--allow-plural-categories` is given, because a language may need
more categories than its source message has.

The helper cannot tell whether a suggestion is good. That judgment is the reviewer's, and then a
native speaker's.
