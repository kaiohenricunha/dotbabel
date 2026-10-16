# French (fr)

Reference for `fr`. Read the rubric first. This file holds what is specific to French, with notes
on `fr-FR`, `fr-CA`, `fr-BE`, and `fr-CH`.

## Scope and variants

Review against the declared variant. When none is given, assume `fr-FR`. Other varieties differ in
vocabulary, typography, and in the terminology bodies they follow. Flag a mix of varieties. Do not
push one variety's terms onto another.

| Area              | France                                               | Québec (fr-CA)                                                                            |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| E-mail            | e-mail, mail, courriel (the official recommendation) | courriel                                                                                  |
| Chat              | chat, tchat                                          | clavardage (official), chat                                                               |
| Parking           | parking                                              | stationnement                                                                             |
| To shop           | faire du shopping, faire les magasins                | magasiner                                                                                 |
| Weekend           | week-end                                             | fin de semaine, week-end                                                                  |
| Meals             | petit déjeuner, déjeuner (lunch), dîner (evening)    | déjeuner (breakfast), dîner (lunch), souper (evening) in Québec, Belgium, and Switzerland |
| Numbers 70 and 90 | soixante-dix, quatre-vingt-dix                       | septante, nonante in Belgium and Switzerland                                              |

The Office québécois de la langue française publishes recommended terminology (the Grand
dictionnaire terminologique and the Vitrine linguistique), and the Charter of the French
Language governs the language of commerce in Québec. France has FranceTerme for official equivalents of English terms. Neither is a
reason to flag the other.

## Register and address

- **Tu or vous.** _Vous_ is the default for customers, strangers, and formal copy. _Tu_ appears
  in informal brand voices (some consumer apps, games, youth brands) and among peers. Keep one
  form within a product. A _tu_ string in a _vous_ app is a finding, as is the reverse.
  _Vous_ also marks the plural.
- **Nous or on.** _On_ replaces _nous_ in speech and friendly copy, and is also the impersonal
  pronoun ("on peut..."). In formal copy prefer _nous_.
- **Politeness formulas.** _Veuillez_ + infinitive is formal. _Merci de_ + infinitive is neutral
  and common in UI, and some readers find it curt. _N'hésitez pas à_ is a stock formula that
  sounds automatic when repeated. _Cordialement_ and _Bien cordialement_ close a business message.
- **Imperative and infinitive.** Buttons use the infinitive (_Enregistrer_) or the imperative
  (_Enregistrez_). Instructions in a UI use the _vous_ imperative (_Cliquez sur_). Manuals often use
  the infinitive. Keep one pattern.
- **Inclusive writing.** The mid-dot form (_étudiant·e·s_) is used by some organizations. The
  Académie française opposes it, and French education authorities have restricted it in schools.
  Follow the house style. Rewording (_les personnes inscrites_) is safe when the text allows it.
- **Negation.** Written French keeps _ne_: _Je ne sais pas_. Dropping _ne_ (_Je sais pas_) belongs
  to speech and chat.

## What reads as native

- **Articles are required.** _Cliquez sur le bouton_ is correct. Telegraphic labels may drop them
  (_Mot de passe_). Running text does not.
- **Active, concrete verbs, and pronominal verbs.** Use _on_ for impersonal statements. Avoid
  strings of nouns joined by _de_ when a verb would do. "Nous procédons à la vérification de..."
  becomes "Nous vérifions...".
- **Adjective position.** Mostly after the noun (_un fichier volumineux_). A small set comes
  before it (_un grand fichier, un petit bouton, un bon outil_).
- **Progressive.** _Être en train de_ is available but the present tense usually suffices. Its
  frequent use follows the English -ing form.
- **Gerund.** _En_ + present participle gives manner or simultaneity (_en cliquant_). English -ing used as a noun
  ("Saving files is...") usually becomes an infinitive or a noun (_Enregistrer des fichiers..._).
  After a noun, French has the present participle (_un fichier contenant des erreurs_), though a
  relative clause (_qui contient_) is the usual choice.
- **Mood.** The subjunctive follows _il faut que, pour que, afin que, bien que_. A wrong mood is
  `mechanics`.
- **Participle agreement.** With _avoir_, the participle agrees with a direct object that comes
  first (_la fonction que nous avons ajoutée_). Mark a clear slip as `mechanics`.
- **Gender of loanwords.** _Un e-mail, un courriel, un fichier, un lien, un bug, une application,
  une API, une URL_ (the last two are feminine, after _interface_ and _adresse_). Keep one gender
  for each word within a text.
- **Filler connectors.** _Dans le cadre de, au niveau de, en termes de, il convient de, il est
  important de noter que_ are heavy and, when stacked, formulaic. Replace one when a simple
  preposition or no phrase at all says the same.

## Transfer errors and calques

From English:

- **False friends.** _Éventuellement_ means "possibly", not "eventually" (_finalement, à terme_).
  _Actuellement_ means "currently", not "actually" (_en fait, en réalité_). _Assister à_ is "to
  attend", not "to assist" (_aider_); transitive _assister quelqu'un_ does mean "to help". _Demander_ is "to ask", not "to demand" (_exiger_).
  _Sensible_ is "sensitive"; "sensible" is _raisonnable_ or _sensé_. _Librairie_ is a bookshop;
  "library" is _bibliothèque_. _Librairie_ for a code library is dominant in developer French, so use
  `low` confidence there. _Location_ is a rental; "location" is _emplacement_ or _lieu_.
  _Contrôler_ is first "to check, inspect". For "to control a device" prefer _commander, piloter,
  réguler_; the sense "to master" (_contrôler la situation_) is common and accepted, so use `low`
  confidence. _Délivrer_ is "to free" or "to issue a document". It is not "to release a version"
  (_publier_) or "to deliver results" (_produire, obtenir_).
- **Adresser un problème** (to address a problem) follows English. _Traiter, aborder, régler_.
- **Supporter** meaning "to support" follows English. _Prendre en charge, être compatible avec_.
- **Réaliser que** meaning "to realize" is widespread, and some editors still prefer _se rendre
  compte que_. Use `medium` confidence.
- **Digital.** In marketing, _digital_ is common. Elsewhere, _numérique_ is the settled word.
- **Initier, impacter, opportunité.** Often borrowed from English senses. _Initier_ traditionally
  means "to introduce someone to a subject" (_lancer, entamer_). _Impacter_ (_avoir un impact sur_)
  and _opportunité_ (_occasion_) are common in business French and disliked by some editors.
  `low` or `medium` confidence.
- **English-style capitalization**: _Mon Compte Utilisateur_ for _Mon compte utilisateur_.
- **Anglicisms in speech** (_deadline, meeting, feedback, call_) have established alternatives
  (_date limite, réunion, retour, appel_). Follow the glossary and the audience. In IT teams, the
  English term may be the house term.

## Orthography, punctuation and typography

- **Spacing before marks.** Conventions differ by country. In France, a narrow no-break space
  precedes `;`, `!`, and `?`, a no-break space precedes `:`, and spaces sit inside guillemets
  (« texte »). In Canada, typographic guidance generally leaves no space before `;`, `!`, and `?`,
  and keeps one before `:`. Check the house style. Missing spaces matter most
  in marketing and print text, so rate them `minor`.
- **Quotation marks.** Guillemets « » with inner spaces. Use curly quotes for a quote within a
  quote. A typographic apostrophe (’) is preferred in careful typography.
- **Numbers.** Decimal comma, thousands separated by a narrow no-break space: _1 234,56 €_. Percent
  with a no-break space: _50 %_. The currency symbol follows the amount.
- **Dates and times.** _Le 5 octobre 2026_, with the weekday and the month in lowercase. _1er_
  only for the first of the month. The 24-hour clock: _14 h 30_ in typeset text, _14:30_ in UI.
- **1990 spelling reform.** Do not flag _évènement_, _maitre_, _nénufar_, or _ognon_ as errors.
- **No serial comma.** French writes _A, B et C_. An English-style comma before _et_ is a calque.
- **Feminized titles** (_la ministre, une autrice_) are accepted by the Académie française since 2019.
  Treat them with the inclusive-writing bullet: follow the house style.
- **Software vocabulary.** _Télécharger_ (download) and _téléverser_ (upload, official in Québec);
  _sauvegarder_ (back up) and _enregistrer_ (save).
- **Placeholders in French.** A placeholder breaks elision and contraction: _modifications de
  {name}_ gives _de Alice_ where French writes _d'Alice_, and _de {thing}_ may need _du_ or _des_.
  An apostrophe directly before a brace (_d'{name}_) starts ICU quoting and breaks the message.
  A variable that stands for a person raises gender agreement (_connecté(e)_). Suggest one string
  with the article inside the variable, or neutral wording, with `low` confidence.
- **Capitals and accents.** Capital letters keep their accents (_À, É_). Titles and headings take
  sentence case. Languages and nationality adjectives are lowercase; nationality nouns are capitalized (_les Français_).
- **Abbreviations.** _M., Mme, Mmes, no_ (typeset with a superscript o), _etc._ without a following
  ellipsis.

## Examples

| Original                                                                                             | Suggested                                                             | Why                                                                                              |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Nous avons réalisé que le fichier était corrompu.                                                    | Nous nous sommes rendu compte que le fichier était corrompu.          | _Réaliser que_ is widespread; some editors prefer the other form. `medium`                       |
| Nous allons adresser le problème dès que possible.                                                   | Nous allons traiter le problème dès que possible.                     | A calque of "address a problem"                                                                  |
| Cliquez sur bouton Enregistrer.                                                                      | Cliquez sur le bouton Enregistrer.                                    | A missing article                                                                                |
| Mon Compte Utilisateur                                                                               | Mon compte utilisateur                                                | English title case; French headings take sentence case                                           |
| Salut ! Ton compte a été bloqué, mais t'inquiète.                                                    | Votre compte a été bloqué. Nous nous en occupons rapidement.          | _Tu_ and spoken forms in a bank notice. The fix keeps the reassurance and lowers the informality |
| Éventuellement, le fichier sera supprimé. (meaning "eventually")                                     | À terme, le fichier sera supprimé.                                    | _Éventuellement_ means "possibly"                                                                |
| Afin de procéder à la vérification de votre configuration, il est nécessaire d'exécuter la commande. | Pour vérifier votre configuration, exécutez la commande.              | Nominal phrases and a stock lead-in; the verb is shorter                                         |
| Dans le paysage numérique actuel, pensez à sauvegarder vos fichiers.                                 | Pensez à sauvegarder vos fichiers.                                    | The opener adds nothing; the instruction stays                                                   |
| Consultez votre courriel ce week-end, ou faites du shopping en ligne. (fr-CA)                        | Consultez votre courriel cette fin de semaine, ou magasinez en ligne. | Mixed vocabulary for a Québec audience. `regional-fit`, `medium`                                 |

## Leave alone

These are not errors. Mention one only when it clashes with the rest of the text or the house
style forbids it.

- _On_ for _nous_ in friendly copy. _Tu_ in a deliberate brand voice.
- _Merci de_ + infinitive. The infinitive on buttons and in manuals.
- In fr-FR, _week-end_, _e-mail_, _logiciel_, and other settled forms. _Courriel_ in France.
- The point médian, in either direction, when the house style sets it.
- Dropped _ne_ in dialogue and chat copy.
- A long sentence that reads easily.

## Verify before ruling

State these as questions, with `low` or `medium` confidence.

- The spacing rules before `;`, `!`, `?`, and `:` for the target country, and for UI against print.
- _Réaliser que_, _impacter_, _opportunité_, _digital_, and _initier_ for a given audience.
- Inclusive writing, which differs by organization and by institution.
- Québec terminology where the Office québécois de la langue française and common usage differ,
  such as _week-end_ against _fin de semaine_.
- The gender of recent loanwords: _mail_ and _e-mail_ are masculine; _une API_ is the standard gender, and _un API_ appears in developer speech. Follow one source.
- _Après que_ takes the indicative in standard written French. The subjunctive is common in speech. In formal copy flag it as `mechanics`, `low` severity; in informal copy leave it.
- Belgian and Swiss terms beyond the ones listed here.
