# Modern Standard Arabic (ar)

Reference for `ar`: Modern Standard Arabic (MSA, _al-fuṣḥā_), the written standard. Read the
rubric first. This file holds what is specific to Arabic, including script, punctuation, and
mixed-direction text.

## Scope and variants

MSA is the written language of news, education, official documents, and most software
interfaces and documentation across the Arab world. Spoken dialects (Egyptian, Levantine, Gulf,
Iraqi, Maghrebi, and others) differ from MSA and from each other, and are written on social media,
in advertising, and in dialogue.

- Review against MSA unless the user declares a dialect.
- Dialect in an MSA product is a `register` finding. Suggest MSA, and do not pick a different
  dialect for it.
- Dialect text that is meant to be dialect is not an error. In that case check only clarity and
  consistency, with `low` confidence. This file does not cover dialect norms.
- Latin-script chat Arabic ("Arabizi") is out of scope.

Regional conventions exist within MSA. Flag a mix of them. Do not force one on another:

- **Vocabulary.** _حاسوب_, _كمبيوتر_, and _حاسب_ all occur for "computer". _تنزيل_ and _تحميل_ both
  appear for "download". Follow the product glossary.
- **Month names.** The Levant and Iraq commonly use _كانون الثاني، شباط، آذار..._ . Egypt and the
  Gulf commonly use _يناير، فبراير، مارس..._ . North African usage has its own forms.
- **Digits.** Western digits (0-9) are standard in the Maghreb and dominate software interfaces.
  Eastern Arabic-Indic digits (٠-٩) are common in print in the Mashriq and the Gulf.

The text is stored in logical order. Review in logical order. Never reverse a string.

## Register and address

- **MSA is formal by nature.** It still has registers: news, legal, administrative, interface,
  and friendly MSA.
- **Gender and number of "you".** Verbs and pronouns mark the gender of the addressee
  (_أنتَ_ masculine, _أنتِ_ feminine, _أنتم_ plural, with the dual _أنتما_ and the feminine plural _أنتنّ_). Interface copy often uses the masculine as a
  default, the plural-formal _كم_ ending, or wording that avoids the question (an imperative
  without an explicit pronoun, a passive, _المستخدم_). Mixed forms inside one string are a
  `consistency` finding. Follow the product's choice.
- **Polite requests.** _يُرجى_ + a verbal noun (_يُرجى إدخال كلمة المرور_) is the standard polite
  request in interfaces. _من فضلك_ addresses one male reader (_من فضلكِ_ and _من فضلكم_ for the other forms). _لطفًا_ and
  _الرجاء_ are neutral for gender and number. _حضرتك_ in direct address leans colloquial (mainly
  Egyptian); _حضرة_ + a title and _حضرتكم_ occur in formal letters.
- **Formal letters.** _تحية طيبة وبعد_ opens one. _وتفضلوا بقبول فائق الاحترام_ closes one.
  _السلام عليكم_ is a greeting of Islamic origin and the everyday greeting in most of the region.
- **Religious phrases** (_إن شاء الله، بإذن الله، جزاك الله خيرًا_) are right in some contexts and
  out of place in others. A reviewer must not add or remove them without a reason.

## What reads as native

- **Word order.** Verb-first (VSO) is traditional and common in formal MSA. Subject-first (SVO) is
  also grammatical and common in modern MSA, especially in news and translation. Neither is an
  error. A run of pronoun-initial SVO sentences can read as translated: `low` or `medium`
  confidence.
- **Verb agreement.** A verb before a plural subject is singular (_ذهب الطلاب_). A verb after it
  agrees (_الطلاب ذهبوا_). The verb also agrees in gender (_ذهبت الطالبات_). A plural of a non-human noun takes feminine singular agreement
  (_الكتب الجديدة مفيدة_).
- **Number and noun.** 3-10 take a plural noun, and the number shows the opposite gender to the
  singular of the noun. 11-99 take a singular accusative noun. Round hundreds, thousands, and millions (100, 1000, 2000) take a singular
  genitive noun. In a compound number the noun follows the last numeral: 103 كتب, 125 كتابًا. Two uses the dual (_رجلان_), not _اثنان رجال_. Numeral agreement is a common source
  of errors. Rate a clear break of a settled rule `high`. Check digits against the target region.
- **Construct state (_idāfa_).** A chain of nouns has no _ال_ on the non-final nouns, and the final
  noun carries the definiteness: _إعدادات حساب المستخدم_ ("user account settings"). Order is
  head-first, the reverse of English. _الإعدادات الحساب_ is an error.
- **Relative pronouns.** _الذي، التي_ follow a definite noun. After an indefinite noun, the clause
  follows with no pronoun: _محلل وظّفه الفريق_.
- **Prepositions follow the verb**, and differ from English: _يعتمد على، يتكوّن من، يهتم بـ، يؤثر على_.
  A wrong preposition is `idiom` or `mechanics`. _يؤثر على_ against _يؤثر في_ is a preference:
  both occur, and conservative editors favor _في_.
- **Passive.** The morphological passive (_يُنفَّذ_) is natural. _يتم_ + a verbal noun (_يتم تنفيذ_)
  is very common in news and administration and is heavily used in translation. Many Arabic
  editors discourage overuse because it replaces plain verbs. Treat it as a style finding with
  `medium` confidence, or as a `preference`.
- **Connectors and sentence length.** Arabic prose links clauses with _و، ف، ثم، حيث، بينما، لكن_.
  A string of short, unconnected English-shaped sentences can read as translated. Interface
  strings are short by nature, so do not apply this to them.

## Transfer errors and calques

From English or French:

- **Light verbs.** _قام بـ_ + a verbal noun for any verb (_قام بتنفيذ العملية_), and _تم_ + a verbal
  noun. Both are understood and widespread. Prefer the plain verb: `medium` or `preference`.
- **Agent of the passive.** _من قبل_ ("by") is common in modern MSA, and some editors prefer
  an active sentence. _على يد_ fits only a human agent of a notable act, and _من طرف_ is common in
  the Maghreb. Style, not error.
- **Overused connectors and prepositions.** _من خلال_ ("through") and _حيث_ ("where, whereas")
  and _يعتبر_ ("is considered") used for "is" or "through". Replace one with a simple preposition
  or verb where it reads heavily.
- **Word-for-word idioms.** A phrase built from English words. Check that the idiom exists before
  flagging it. Some calques are now standard (_يلعب دورًا_, "plays a role").
- **Latin-script terms.** Product names, commands, and code stay Latin. Established technical
  terms are often transliterated (_إنترنت_). Follow the glossary. Do not transliterate part of a
  command or an identifier.
- **Gender mixing.** A feminine noun with a masculine adjective, or a masculine address in a
  feminine-address string.

## Orthography, punctuation and typography

- **Letter forms.** Hamza (_أ إ ؤ ئ ء_), _ة_ against _ه_, and _ى_ against _ي_ are frequent slips in
  informal typing. A clear slip is `mechanics`.
- **Hamzat al-wasl and hamzat al-qaṭʿ.** _استخدام_, not _إستخدام_; _الاسم_, not _الإسم_. A common slip.
- **Persian letters.** _ی_ (U+06CC) and _ک_ (U+06A9) in place of Arabic _ي_ and _ك_ are an error,
  like Persian digits.
- **Endings that show in unvocalized text.** The final nun drops in a construct (_مهندسو الشركة_) and
  after _لن، لم، أن_ (_لن يستطيعوا_). Check _ـون_ and _ـين_ after _كان_ and _إنّ_.
- **Diacritics.** Short vowels (_tashkeel_) are normally omitted. They appear to remove ambiguity,
  in teaching material, and in religious text. Do not add full vowelization. Leave existing
  partial vowelization. _تنوين الفتح_ (_شكرًا_) is common in typed text.
- **Tatweel (_ـ_).** Avoid in body text. It is acceptable in some branding and titles.
- **Punctuation.** Standard typography uses the Arabic comma ، (U+060C), semicolon ؛ (U+061B), and
  question mark ؟ (U+061F). Latin `,` `;` `?` appear in informal digital text and in some
  interface frameworks. Normalize them for formal print. Keep the full stop `.` and colon `:`.
  Quotation marks are « » or “ ”. Store parentheses as `(` and `)`; the bidirectional algorithm
  mirrors them. Do not swap them by hand.
- **Digits.** Western (0-9) and Eastern Arabic-Indic (٠-٩) are both acceptable. Use one set within
  a string and a document. Persian and Urdu digits (۰-۹, such as ۴ ۵ ۶) are different characters
  and are an error in Arabic text. The Arabic percent sign is ٪, and the decimal separator ٫, with
  Eastern digits. With Western digits the decimal separator is `.` in most of the Mashriq and `,` in Algeria,
  Morocco, and Tunisia (CLDR). With Eastern digits the thousands separator is ٬ (U+066C). Follow
  the locale data.
- **Dates.** Day, month, year. Say whether the calendar is Hijri or Gregorian where it matters.
- **Plural categories** (CLDR) for ICU: `zero` (0), `one` (1), `two` (2), `few` (n mod 100 is 3-10),
  `many` (n mod 100 is 11-99), and `other` (everything else, including 100-102). A message with
  only `one` and `other` is incomplete. Report it as `markup` or `mechanics`. A suggestion that
  adds categories passes `check-review.mjs` only with `--allow-plural-categories`.

### Mixed-direction text

Latin words, numbers, URLs, code, and placeholders (`{count}`, `%s`) sit inside right-to-left text.

- **Keep tokens whole and unmarked.** Never insert a directional mark inside a placeholder, an
  identifier, a URL, or a code span.
- **Neutral characters at the edge of a left-to-right run** can render on the wrong side, because
  their direction comes from the paragraph. A final full stop after a Latin word is usually fine in
  a right-to-left sentence. A token that begins or ends with symbols (_./app_, _C++_) can show its
  symbols displaced (_app/._, _++C_). Preferred fixes are markup (`dir="auto"`, `<bdi>`, or code
  markup) in HTML and isolates in frameworks that provide them. A left-to-right mark (U+200E) at the
  edge where the symbols sit is a last resort in plain strings. A string that starts with a Latin
  word may make the paragraph left-to-right; a leading right-to-left mark (U+200F) fixes that.
- **Rendering is not visible to this review.** Report a likely problem as a `low` or `medium`
  confidence note and ask for a check on screen.
- **Markdown.** Code spans and URLs are left-to-right content, but they are not isolated by
  default; HTML `<code>` needs `dir` or `<bdi>`. A paragraph that begins with a Latin
  word can render left to right in some viewers. Check it.
- **Stray spaces** before a full stop after a Latin token (_Node.js ._) are `mechanics`.

## Examples

| Original                                                | Suggested                            | Why                                                                                                              |
| ------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| قام النظام بتنفيذ العملية، وتم إرسال الإشعار.           | نفّذ النظام العملية وأُرسل الإشعار.  | _قام بـ_ and _تم_ + a verbal noun replace plain verbs. Common and understood; style, `medium`                    |
| معلش، التحويل ما نفعش.                                  | عذرًا، تعذّر إتمام التحويل.          | Egyptian colloquial in an interface written in MSA                                                               |
| سيُعقد الاجتماع في كانون الثاني وفي فبراير.             | سيُعقد الاجتماع في يناير وفي فبراير. | Two month-name conventions in one text. `consistency`, confirm the region                                        |
| الإعدادات الحساب                                        | إعدادات الحساب                       | _ال_ on the first noun of a construct chain                                                                      |
| ذهبوا الطلاب إلى المدرسة.                               | ذهب الطلاب إلى المدرسة.              | A verb before a plural subject is singular                                                                       |
| يوجد 5 ملفات و٣ مجلدات.                                 | يوجد 5 ملفات و3 مجلدات.              | Western and Eastern digits mixed in one sentence                                                                 |
| ثبّت Node.js .                                          | ثبّت Node.js.                        | A stray space before the full stop after a Latin token. `mechanics`; the rendering is not visible to this review |
| قم بتثبيت التطبيق ثم قم بتشغيله.                        | ثبّت التطبيق ثم شغّله.               | A light verb repeated before each action                                                                         |
| في عالم رقمي سريع التطور، لا تنسَ نسخ ملفاتك احتياطيًا. | لا تنسَ نسخ ملفاتك احتياطيًا.        | The opener adds nothing; the instruction stays                                                                   |

## Leave alone

These are not errors. Mention one only when it clashes with the rest of the text or the house
style forbids it.

- Verb-first or subject-first order. Partial vowelization already in the text.
- _يتم_ in official, legal, and administrative text where it is the established idiom.
- Dialect in advertising and dialogue aimed at a dialect market. In that case it is not MSA.
- Established transliterations (_فيسبوك، إنترنت_). Western or Eastern digits, if used consistently.
- Latin `?` and `,` in an interface that uses them consistently.
- _السلام عليكم_ and similar greetings where the audience expects them.
- A masculine default address, if the product chose it and uses it consistently.

## Verify before ruling

State these as questions, with `low` or `medium` confidence.

- Regional vocabulary and month names for the target country. Levantine media often print both
  (_كانون الثاني/يناير_); that is not an inconsistency.
- Coordinated construct heads (_إعدادات وخيارات الحساب_), which are widespread. Traditional
  grammarians prefer repeating the noun. Treat it as a preference.
- _تنزيل_ against _تحميل_, and _من قبل_ against alternatives. Glossaries differ.
- How much _يتم_ and _قام بـ_ to discourage for the register.
- The digit set and the decimal separator for the target country.
- Gender defaults in the address, which vary by product and country.
- Religious and cultural phrases, and any content on a sensitive subject.
- Anything that depends on rendering: bidirectional order, joining, and font. Ask for a check on
  screen.
- Legal or official text. A native specialist should review it.
