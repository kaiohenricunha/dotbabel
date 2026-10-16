# Spanish (es)

Reference for `es`, with configurable regional variants. Read the rubric first. This file holds
what is specific to Spanish.

## Scope and variants

Spanish is pluricentric. Review against the declared variant. When none is given, assume Latin
American Spanish with _tú_ and _ustedes_, unless the text shows `es-ES` or another variant. Main
targets: `es-ES` (Spain), `es-MX` (Mexico), `es-AR` and `es-UY` (Rio de la Plata), `es-CO`,
`es-CL`, and others. A "neutral" Latin American text (`es-419`) is a deliberate localization
choice: general vocabulary, _tú_ or _usted_, and _ustedes_. Flag a mix of variants. Do not
"correct" one variant toward another.

| Area           | Spain                                                         | Latin America (varies)                         |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Computer       | ordenador                                                     | computadora, computador                        |
| Mobile phone   | móvil                                                         | celular                                        |
| Car            | coche                                                         | carro, auto (_coche_ is also common in Mexico) |
| Plural "you"   | vosotros, with -áis and -éis forms                            | ustedes                                        |
| Juice, to park | zumo, aparcar                                                 | jugo, estacionar                               |
| Click          | hacer clic, pulsar                                            | hacer clic, dar clic, presionar                |
| Past events    | pretérito perfecto is common for the recent past: _he comido_ | pretérito indefinido is common: _comí_         |

**Address systems.** _Tuteo_ (_tú tienes_). _Voseo_ (_vos tenés_; imperative _hacé_) is standard in
Argentina, Uruguay, and Paraguay. It is common beside or instead of _tuteo_ in Central America,
Chile, parts of Colombia, Bolivia, Ecuador, Zulia, and Chiapas. _Ustedeo_ (_usted_ among familiars) in some regions.
_Vosotros_ in Spain. Do not turn _voseo_ into _tuteo_ for a voseo audience, and do not
use _vosotros_ for a Latin American one.

## Register and address

- **Tú or usted.** Consumer apps use _tú_ in Spain and in many Latin American countries. Banks,
  government, and B2B writing often use _usted_ in Latin America. Some countries (Colombia, for
  one) use _usted_ widely. Keep one choice per product. Switching inside a sentence or a screen
  is a finding.
- **Imperatives** follow the choice: _Haz clic_ (_tú_), _Haga clic_ (_usted_), _Hacé clic_
  (_vos_). Buttons use the infinitive: _Guardar, Enviar_.
- **Formal letters.** _Estimado/a_ opens one. _Atentamente_ or _Un cordial saludo_ closes it.
  _Saludos_ is neutral. _Un abrazo_ is informal.
- **Gender.** The masculine is the traditional generic. _Todos y todas_, _todes_, _@_, and _x_
  are used by some organizations. The Real Academia Española rejects _e_, _@_, and _x_ as foreign to Spanish morphology, and treats systematic doubling (_todos y todas_) as unnecessary, keeping the generic masculine.
  Follow the house style. Neutral wording (_la ciudadanía, el equipo, quienes_) is safe when the
  text leaves room.
- **Colloquial markers** are strongly regional: _vale, tío, guay_ (Spain), _chévere_ (Caribbean,
  Colombia, Peru), _padre_ (Mexico), _bacán_ (Chile, Peru), _che_ (Rio de la Plata). A reviewer must not introduce them. Flag one that is foreign to
  the target region.

## What reads as native

- **Pro-drop.** The subject pronoun is omitted unless it contrasts or clarifies. _Hemos recibido su
  solicitud_ over _Nosotros hemos recibido su solicitud_. Repeated _yo_ or _nosotros_ sounds
  translated.
- **Reflexive and impersonal _se_.** _Se guardó el archivo_ and _Se recomienda..._ over _El archivo
  fue guardado por el sistema_. An active verb is also natural.
- **Articles.** The definite article appears with abstract and generic nouns (_La seguridad es
  importante_), with weekdays (_el lunes_), and with body parts or clothing in place of a
  possessive (_Lávate las manos_).
- **Adjective position.** After the noun to distinguish (_un archivo grande_). Before it to
  evaluate or stress (_una gran idea_). Some adjectives change meaning (_un gran hombre_, _un
  hombre grande_).
- **Personal _a_.** _Veo a María_, not _Veo María_.
- **Subjunctive.** A required subjunctive (_para que, espero que, dudo que, no creo que_) is
  `mechanics` when missing. After _aunque, quizá, cuando, como_ and similar words the mood depends
  on the meaning (_Aunque llueve, salgo_ is correct), so check before flagging.
- **Gerund.** For manner or simultaneity. A gerund that modifies a noun (_una caja conteniendo_) is
  non-standard, with settled exceptions (_agua hirviendo, clavo ardiendo_) and complements of
  perception verbs (_vi a un niño jugando_). The gerund of posteriority (_se envió un correo,
  siendo recibido..._) is traditionally censured.
- **Ambiguous _su_.** _Su_ can mean his, her, their, your. Use _de él, de ella, de ustedes_ when
  the reader could misread it.

## Transfer errors and calques

From English:

- **Apply for.** _Aplicar para un puesto_ and _aplicación_ for a job application follow English.
  _Solicitar un puesto, postularse, presentar la candidatura, solicitud_ are the conventional
  forms. In Latin America _aplicar a_ is spreading, so use `medium` confidence there. _Postularse_ is
  Latin American; in Spain it mostly means standing for office, so prefer _solicitar el puesto_
  or _presentar la candidatura_.
- **False friends.** _Actualmente_ means "currently", not "actually" (_en realidad_).
  _Eventualmente_ means "possibly, occasionally", not "eventually" (_finalmente, al final, tarde o temprano_). The English sense is now widespread in Mexican and Rio de la Plata usage, so use `medium` confidence for those targets. _Realizar_ is
  "to carry out"; "to realize" is _darse cuenta_. _Soportar_ is "to bear"; "to support" is _admitir,
  ser compatible con, dar soporte a_. Other traps: _evidencia_ is "proof", not "evidence" in the
  legal sense; _introducir_ is "to insert", not "to introduce a person" (_presentar_). _Constipado_ means "having a cold" in Spain and can mean "constipated" (_estreñido_) in much of
  Latin America. _Embarazada_ is "pregnant"; "embarrassed" is _avergonzado_.
  _Éxito_ is "success"; "exit" is _salida_. _Billón_ is 10^12; the American "billion" is _mil
  millones_. _Sensible_ is "sensitive"; "sensible" is _sensato_.
- **"Assume".** _Asumir_ for "suppose" is a calque and is increasingly accepted. `low` or
  `medium` confidence.
- **The agentive passive.** _Fue aprobado por la dirección_ is grammatical and normal in formal,
  legal, and journalistic registers, but less frequent than the active _La dirección aprobó..._.
  The reflexive _Se aprobó..._ fits only when the agent is irrelevant, since it cannot carry it.
- **Noun chains and long _de_ strings.** _Configuración de usuario de la cuenta_ can be
  rearranged. Check that the order is natural.
- **Anglicisms in verbs.** _Chequear_ and _resetear_ are widely accepted, especially in Latin America; careful copy may
  prefer _comprobar_ and _restablecer_ (to defaults) or _reiniciar_ (a device). _Linkear, loguearse,
  deletear_ are speech forms; prefer _enlazar, iniciar sesión, eliminar_.
  _Librería_ for a code library is widespread in computing, although _biblioteca_ is more
  precise.

## Orthography, punctuation and typography

- **Frequent errors.** _Queísmo_ and _dequeísmo_ (_pienso de que_); impersonal _haber_ in the plural
  (_habían muchas personas_); padding such as _en base a_ and _a nivel de_.
- **Interface vocabulary** varies: _ratón_ and _mouse_, _portátil_ and _laptop_, _fichero_ and
  _archivo_, _enlace_ and _vínculo_, _iniciar sesión_ and _ingresar_, _subir_ and _cargar_. For a
  United States audience (`es-US`), follow the product glossary.
- **Opening marks.** _¿_ and _¡_ are part of standard punctuation. A missing one is `mechanics`.
- **Accents.** Under the 2010 orthography, _solo_ and the demonstratives _este, ese, aquel_ no
  longer need a tilde. A tilde on them is old-fashioned, not wrong in older house styles. Keep one
  convention.
- **Capitalization.** Lowercase for weekdays, months, languages, and nationality adjectives.
  Headings and titles use sentence case, not English title case.
- **Numbers.** The Academies accept both the decimal comma and the decimal point, and the 2010 _Ortografía_
  recommends the point. The comma is customary in Spain and much of South America; Mexico,
  much of Central America, and the Caribbean use the point. For thousands the Academies prescribe a
  thin or no-break space (_30 000_), not a point or a comma. Check the target. Currency is _5 €_
  in Spain and _$5_ in much of Latin America.
- **Dates and times.** _05/10/2026_ is day/month/year. Spain usually uses the 24-hour clock.
  Many Latin American countries use the 12-hour clock with _a. m._ and _p. m._.
- **Quotation marks.** Guillemets (« ») are the Academy's first choice and are common in Spain.
  Curly double quotes (“ ”) are common in Latin America.
- **Abbreviations.** _Sr., Sra., Ud., Uds., p. ej._.
- **Email.** _Correo electrónico_, _email_ and _e-mail_ all occur. Keep one.

## Examples

| Original                                                                                       | Suggested                                                            | Why                                                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Nosotros hemos recibido su solicitud y nosotros la procesaremos en un breve período de tiempo. | Hemos recibido su solicitud y la procesaremos en breve.              | Spanish drops the subject pronoun unless it contrasts. Repeating it sounds translated                         |
| Por favor aplique para el puesto enviando su aplicación.                                       | Para postularse al puesto, envíe su solicitud.                       | Calques of "apply for" and "application"                                                                      |
| El archivo fue guardado por el sistema.                                                        | El sistema guardó el archivo.                                        | An agentive passive with _por_ follows English. A reflexive passive also works: _Se guardó el archivo_        |
| Eventualmente recibirás el correo. (meaning "eventually")                                      | Tarde o temprano recibirás el correo.                                | _Eventualmente_ means "possibly, occasionally". The English sense is spreading, so `medium` for Latin America |
| Una caja conteniendo tres archivos                                                             | Una caja que contiene tres archivos                                  | A gerund that modifies a noun is non-standard, with settled exceptions such as _agua hirviendo_               |
| Para guardar en tu ordenador, haz clic y ustedes podrán elegir la carpeta.                     | Para guardar en tu computadora, haz clic y podrás elegir la carpeta. | Peninsular vocabulary in a Latin American text, and a switch from _tú_ to _ustedes_                           |
| ¡Ey, colega! Tu factura sigue sin pagar, ponte las pilas.                                      | Le recordamos que su factura sigue pendiente de pago.                | Slang and an imperative in a payment reminder; the fix moves to _usted_                                       |
| Mande tu documento por correo.                                                                 | Manda tu documento por correo.                                       | _Usted_ imperative with a _tú_ possessive. `consistency`                                                      |
| En el vertiginoso mundo actual, recuerda respaldar tus archivos.                               | Recuerda respaldar tus archivos.                                     | The opener adds nothing; the instruction stays                                                                |

## Leave alone

These are not errors. Mention one only when it clashes with the rest of the text or the house
style forbids it.

- _Voseo_ for a Rio de la Plata audience. _Vosotros_ for Spain. _Ustedes_ in the Canary Islands
  and western Andalusia.
- Masculine-singular _leísmo_ with people (_le vi_), which is accepted. _Laísmo_, _loísmo_, and
  _leísmo_ with things are non-standard. Regional tense choices (_he comido_ against _comí_).
- _Vale_, _ahorita_, _chévere_, and other regional words in their region.
- _Software, email, hardware_ and settled technical loanwords.
- Gender-inclusive wording, in either direction, when the house style sets it.
- The infinitive on buttons. A passive that suits an impersonal technical register.

## Verify before ruling

State these as questions, with `low` or `medium` confidence.

- Gender-inclusive forms, which vary by organization and by country.
- _Aplicar a_ and _asumir_ in the sense of English "apply" and "assume", which are spreading.
- Whether the product expects _tú_ or _usted_ in a given country.
- The decimal and thousands separators for a specific country.
- Whether _librería_ or _biblioteca_ is expected for a code library.
- Whether _ustedes_ or _vosotros_ is expected in the Canary Islands and southern Spain.
- Plural categories for ICU: CLDR gives Spanish `one`, `many` (for large round numbers in recent
  versions), and `other`. Check the version the project uses.
