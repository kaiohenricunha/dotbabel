# Review examples

Worked reports for the seven supported languages. They show the judgment the skill is meant to
exercise: findings that name what a reader stumbles on, text left alone when it is natural, and
uncertainty stated where it exists. The outputs are illustrations, not a fixed script. A different
run may phrase them differently. Every report ends with the limits line, shortened here after the
first.

## Original text

### en · product documentation with a stock opener

```text
/language-review "In today's fast-paced digital landscape, it is of paramount importance that all users make sure to back up their files on a regular basis in order to avoid the loss of data. Our innovative backup solution seamlessly empowers you to safeguard your information." --lang en-US --audience "end users" --domain "product docs"
```

```text
Language review · en-US · pasted text
Assumed: audience end users · register neutral, friendly · domain product docs · variant assumed (US)
Verdict: needs-revision — a stock opener, a buried instruction, and a hollow claim.

F1 · artificial-style · major · high · sentence 1
  Original:  In today's fast-paced digital landscape, it is of paramount importance that all users make sure to back up their files on a regular basis in order to avoid the loss of data.
  Suggested: Back up your files regularly so you do not lose data.
  Why: The opener says nothing the instruction does not, and "it is of paramount importance that all users make sure to" buries the action. The revision keeps the one fact: back up regularly to avoid data loss.

F2 · artificial-style · minor · medium · sentence 2
  Original:  Our innovative backup solution seamlessly empowers you to safeguard your information.
  Suggested: Our backup solution helps you protect your information.
  Why: "Innovative", "seamlessly", and "empowers" are generic and carry no claim. The revision keeps the claim the sentence actually makes.
  Unsure: If the product has a concrete capability, such as scheduled backups, naming it would be stronger. I did not add one, because the text does not say.

Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

### de · interface strings: a register slip and a split compound

```text
/language-review locales/de.json --lang de-DE --register "Sie, neutral"
```

```json
{
  "auth.email_label": "Bitte geben Sie Ihre E Mail Adresse ein.",
  "auth.error": "Hey! Das hat leider nicht geklappt. Probier's nochmal, okay?",
  "auth.hint": "Ihr Passwort muss mindestens {min} Zeichen lang sein."
}
```

```text
Language review · de-DE · locales/de.json
Assumed: audience app users · register neutral, Sie · domain UI copy · variant assumed (de-DE)
Verdict: needs-revision — one string uses du-style informality in a Sie product.

F1 · register · major · high · auth.error (line 3)
  Original:  Hey! Das hat leider nicht geklappt. Probier's nochmal, okay?
  Suggested: Das hat leider nicht geklappt. Bitte versuchen Sie es erneut.
  Why: The other strings address the user with Sie. A du command and spoken forms in an error read as a different voice. The fix removes the informality; it adds none.

F2 · mechanics · minor · high · auth.email_label (line 2)
  Original:  Bitte geben Sie Ihre E Mail Adresse ein.
  Suggested: Bitte geben Sie Ihre E-Mail-Adresse ein.
  Why: A compound with a foreign part takes a hyphen between each element. The spaces are an English habit.

Left alone: auth.hint is natural. The placeholder {min} is untouched.
Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

### id-ID · a support reply with a calque and a mixed form of address

```text
/language-review "Halo Kak, terima kasih sudah menghubungi kami. Pesanan dari Anda telah dikirim dengan sukses pada hari kemarin dan akan sampai dalam waktu 2-3 hari kerja." --lang id-ID --domain "customer support"
```

```text
Language review · id-ID · pasted text
Assumed: audience online shoppers · register polite, customer service · variant standard Indonesian
Verdict: needs-revision — English-shaped phrasing and two forms of address.

F1 · idiom · major · high · sentence 2
  Original:  Pesanan dari Anda telah dikirim dengan sukses pada hari kemarin dan akan sampai dalam waktu 2-3 hari kerja.
  Suggested: Pesanan Anda sudah dikirim kemarin dan akan sampai dalam 2-3 hari kerja.
  Why: "Dari" for possession, "dengan sukses", "pada hari kemarin", and "dalam waktu" follow English. Indonesian puts the possessor after the noun and says "kemarin" alone.

F2 · register · minor · low · sentence 1
  Original:  Halo Kak, terima kasih sudah menghubungi kami.
  Suggested: Halo, terima kasih sudah menghubungi kami.
  Why: "Kak" is a friendly form of address and "Anda" is formal. Using both in one message mixes the voices.
  Unsure: The brand voice is not given. If the shop speaks as "Kak" throughout, keep the greeting and change "Anda" to "Kakak" instead.

Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

### fr · natural text, so no findings

```text
/language-review "Vos modifications sont enregistrées automatiquement. Vous pouvez fermer cette fenêtre à tout moment. Pour en savoir plus, consultez l’aide en ligne." --lang fr-FR
```

```text
Language review · fr-FR · pasted text
Assumed: audience app users · register neutral, vous · domain UI copy
Verdict: natural — no actionable findings.

Left alone: the consistent "vous", the articles, and the typographic apostrophe are all in order.
Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

A reviewer that "improved" this text would have changed its register or added politeness
formulas for no reason. That is the failure the skill is built to avoid.

## Translation against its source

### pt-BR · a locale file with ICU and markup, checked against English

```text
/language-review locales/pt-BR.json --source locales/en.json --lang pt-BR --audience shoppers
```

```json
{
  "cart.title": "O seu carrinho",
  "home.welcome": "Bem-vindo, {name}!",
  "cart.items": "{count, plural, one {# item} other {# itens}} no seu carrinho",
  "cart.checkout": "Ir para o <b>pagamento</b>",
  "error.payment": "Não foi possível processar o seu pagamento."
}
```

```text
Language review · pt-BR · locales/pt-BR.json (source: locales/en.json)
Assumed: audience shoppers · register neutral, "você" · domain e-commerce UI
Verdict: needs-revision — one omission against the source.

F1 · fidelity · major · high · error.payment (line 6)
  Original:  Não foi possível processar o seu pagamento.
  Suggested: Não foi possível processar o seu pagamento. Tente novamente.
  Why: The source ends with "Please try again." The translation drops the instruction, so the reader is told what failed and not what to do.

F2 · lexical-choice · minor · low · home.welcome (line 3)
  Original:  Bem-vindo, {name}!
  Suggested: Boas-vindas, {name}!
  Why: The masculine form assumes the user's gender, and the source "Welcome" does not.
  Unsure: "Bem-vindo" is a common default. Change it only if the house style avoids gendered forms.

Left alone: the ICU skeleton, the "#" markers, "<b>", and the placeholder in cart.items are intact.
"O seu carrinho" keeps a correct article before the possessive. "Ir para o pagamento" is a normal
label for the checkout step.
Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
```

### es-MX · JSON output for a tool or CI

```text
/language-review "Por favor aplique para el puesto enviando su aplicación antes del viernes." --lang es-MX --format json
```

```json
{
  "language": "es-MX",
  "verdict": "needs-revision",
  "assumptions": {
    "audience": "job applicants in Mexico",
    "register": "formal, usted",
    "domain": "careers page"
  },
  "findings": [
    {
      "id": "F1",
      "location": "careers.apply",
      "original": "Por favor aplique para el puesto enviando su aplicación antes del viernes.",
      "suggestion": "Para postularse al puesto, envíe su solicitud antes del viernes.",
      "category": "idiom",
      "severity": "major",
      "confidence": "medium",
      "explanation": "'Aplicar para' and 'aplicación' follow English 'apply for' and 'application'. 'Postularse' and 'solicitud' are the conventional Latin American forms, and the usted register is kept. The English-shaped use is spreading, so the confidence is medium."
    }
  ],
  "disclaimer": "AI-assisted review. It does not replace a native-speaking editor for high-stakes content."
}
```

Save the reply and check it:

```bash
node skills/language-review/scripts/check-review.mjs validate review.json
```

### ar · right-to-left text with Latin tokens, and an incomplete plural message

```text
/language-review docs/ar/setup.md --lang ar --preserve Node.js
```

```markdown
قم بتثبيت Node.js ثم قم بتشغيل الأمر `npm install` داخل المجلد ./app .

{count, plural, one {يوجد عنصر واحد في سلتك.} other {يوجد # عناصر في سلتك.}}
```

```text
Language review · ar · docs/ar/setup.md
Assumed: audience developers · register Modern Standard Arabic, instructional · domain technical docs
Verdict: needs-revision — a plural message with too few categories.

F1 · markup · major · high · line 3
  Original:  {count, plural, one {يوجد عنصر واحد في سلتك.} other {يوجد # عناصر في سلتك.}}
  Suggested: {count, plural, zero {سلتك فارغة.} one {في سلتك عنصر واحد.} two {في سلتك عنصران.} few {في سلتك # عناصر.} many {في سلتك # عنصرًا.} other {في سلتك # عنصر.}}
  Why: Arabic has six plural categories. With only "one" and "other", a count of 2 or 11 uses the wrong noun form ("2 عناصر"). The revision adds the missing categories and keeps the "#" markers.
  Note: the check-review.mjs preserve check reports added categories unless --allow-plural-categories is given.

F2 · idiom · minor · medium · line 1
  Original:  قم بتثبيت Node.js ثم قم بتشغيل الأمر
  Suggested: ثبّت Node.js ثم شغّل الأمر
  Why: "قم بـ" before each verbal noun is a light-verb pattern that replaces plain imperatives. It is understood and common, so this is polish, not an error.

F3 · mechanics · minor · high · line 1
  Original:  ./app .
  Suggested: ./app.
  Why: The space before the full stop is stray. This review cannot see rendering, and a full stop after a Latin path inside right-to-left text can appear on the wrong side in some viewers. If it moves, set the direction in the viewer or the markup rather than adding invisible marks to the text.

Left alone: "Node.js", the code span, and "./app" are untouched, and the imperative address is consistent.
Limits: AI-assisted review; it does not replace a native-speaking editor for high-stakes text.
Rendering of mixed-direction text was not checked on screen.
```
