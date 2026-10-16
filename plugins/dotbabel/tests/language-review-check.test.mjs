import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  CONFIDENCES,
  SEVERITIES,
  VERDICTS,
  compareProtectedTokens,
  extractProtectedTokens,
  validateReviewDocument,
} from "../../../skills/language-review/scripts/check-review.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "language-review",
  "scripts",
  "check-review.mjs",
);

function values(text, kind, opts) {
  return extractProtectedTokens(text, opts)
    .tokens.filter((t) => t.kind === kind)
    .map((t) => t.value);
}

describe("extractProtectedTokens: ICU", () => {
  it("reads arguments, plural selectors and # markers", () => {
    const text = "{count, plural, one {# arquivo} other {# arquivos}}";
    const { tokens, errors } = extractProtectedTokens(text);
    expect(errors).toEqual([]);
    expect(values(text, "icu-arg")).toEqual(["{count,plural}"]);
    expect(values(text, "icu-selector")).toEqual(["count.one", "count.other"]);
    expect(tokens.filter((t) => t.kind === "icu-hash")).toHaveLength(2);
  });

  it("reads select nested inside plural, and simple arguments inside options", () => {
    const text =
      "{n, plural, one {{gender, select, female {Ela tem # item} other {Ele tem # item}}} other {{name} tem # itens}}";
    expect(values(text, "icu-selector")).toEqual([
      "n.one",
      "gender.female",
      "gender.other",
      "n.other",
    ]);
    expect(values(text, "placeholder")).toEqual(["{name}"]);
  });

  it("does not treat a French apostrophe as ICU quoting", () => {
    const text = "L'utilisateur {name} a {count, plural, one {# fichier} other {# fichiers}}";
    const { errors } = extractProtectedTokens(text);
    expect(errors).toEqual([]);
    expect(values(text, "placeholder")).toEqual(["{name}"]);
  });

  it("treats an apostrophe before a brace as quoting, not as an argument", () => {
    const { tokens, errors } = extractProtectedTokens("Use '{' and '}' literally, {name}.");
    expect(errors).toEqual([]);
    expect(tokens.filter((t) => t.kind === "placeholder").map((t) => t.value)).toEqual(["{name}"]);
  });

  it("keeps the style of date and number arguments", () => {
    expect(values("{d, date, short} e {n, number}", "icu-arg")).toEqual([
      "{d,date,short}",
      "{n,number}",
    ]);
  });

  it("reports an unterminated ICU block", () => {
    expect(extractProtectedTokens("{count, plural, one {# a}").errors.length).toBeGreaterThan(0);
    expect(extractProtectedTokens("texto {nome").errors.length).toBeGreaterThan(0);
  });
});

describe("extractProtectedTokens: other placeholder syntaxes", () => {
  it("reads printf specifiers and ignores a bare percent sign", () => {
    expect(values("%s tem %1$d itens (100%%)", "format")).toEqual(["%s", "%1$d", "%%"]);
    expect(values("100% seguro e 50 % de desconto", "format")).toEqual([]);
  });

  it("reads mustache, template-literal, Rails, Python and i18next syntaxes", () => {
    const text = "{{name}} ${user} %{count} %(total)s $t(common.save)";
    expect(values(text, "template")).toEqual([
      "{{name}}",
      "${user}",
      "%{count}",
      "%(total)s",
      "$t(common.save)",
    ]);
  });
});

describe("extractProtectedTokens: markup", () => {
  it("reads tags and keeps non-translatable attribute values", () => {
    const text = 'Veja <a href="https://example.com/a" class="x">aqui</a><br/>';
    expect(values(text, "tag")).toEqual(["<a>", "</a>", "<br/>"]);
    expect(values(text, "attr")).toEqual(["a@href=https://example.com/a", "a@class=x"]);
  });

  it("treats translatable attributes as present, with a free value", () => {
    const a = values('<img src="a.png" alt="Foto da equipe">', "attr");
    const b = values('<img src="a.png" alt="Team photo">', "attr");
    expect(a).toEqual(b);
    expect(a).toContain("img@alt");
  });

  it("reads numbered Trans tags and HTML entities", () => {
    const text = "<0>Clique</0>&nbsp;&amp;&#8230;";
    expect(values(text, "tag")).toEqual(["<0>", "</0>"]);
    expect(values(text, "entity")).toEqual(["&nbsp;", "&amp;", "&#8230;"]);
  });

  it("reads inline code spans and fenced code blocks as whole units", () => {
    const text = "Rode `npm install -g x` agora.\n\n```bash\nls -la\n```\n";
    expect(values(text, "code-span")).toEqual(["`npm install -g x`"]);
    expect(values(text, "code-fence")).toEqual(["```bash\nls -la\n```"]);
  });

  it("does not read identifiers or placeholders inside a code span twice", () => {
    const text = "Use `getUserName({id})` aqui.";
    expect(values(text, "code-span")).toEqual(["`getUserName({id})`"]);
    expect(values(text, "identifier")).toEqual([]);
    expect(values(text, "placeholder")).toEqual([]);
  });
});

describe("extractProtectedTokens: URLs, links and identifiers", () => {
  it("strips trailing prose punctuation from bare URLs, including Arabic punctuation", () => {
    expect(values("Veja https://example.com/a/b, e depois.", "url")).toEqual([
      "https://example.com/a/b",
    ]);
    expect(values("راجع https://example.com/a؟", "url")).toEqual(["https://example.com/a"]);
  });

  it("keeps a balanced closing parenthesis and drops an unbalanced one", () => {
    expect(values("(veja https://example.com/a)", "url")).toEqual(["https://example.com/a"]);
    expect(values("https://example.com/w_(x)", "url")).toEqual(["https://example.com/w_(x)"]);
  });

  it("reads Markdown link destinations once and leaves link text free", () => {
    const text = "Leia [o guia](./docs/guia.md) e [site](https://example.com).";
    expect(values(text, "link-dest")).toEqual(["./docs/guia.md", "https://example.com"]);
    expect(values(text, "url")).toEqual([]);
  });

  it("reads e-mail addresses", () => {
    expect(values("Escreva para ajuda@example.com hoje.", "email")).toEqual(["ajuda@example.com"]);
  });

  it("reads camelCase, PascalCase, snake_case, dotted names, flags and paths", () => {
    const text = "getUserName OAuth DotBabel iOS max_retries user.profile.name --force ~/.claude/x";
    expect(values(text, "identifier")).toEqual([
      "getUserName",
      "OAuth",
      "DotBabel",
      "iOS",
      "max_retries",
      "user.profile.name",
      "--force",
      "~/.claude/x",
    ]);
  });

  it("does not mistake ordinary prose for identifiers", () => {
    const text = "Use e/ou km/h, i.e. 24/7, e.g. a Fim.Início Hello World API";
    expect(values(text, "identifier")).toEqual([]);
  });
});

describe("extractProtectedTokens: Markdown structure, bidi, and fixed terms", () => {
  it("reads headings, lists, quotes, tables and rules", () => {
    const text =
      "## Título\n\n- um\n- dois\n1. a\n> citação\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n";
    const found = values(text, "md");
    expect(found).toContain("heading:2");
    expect(found.filter((v) => v === "list")).toHaveLength(2);
    expect(found).toContain("olist");
    expect(found).toContain("quote");
    expect(found).toContain("table-row:2");
    expect(found).toContain("table-sep");
    expect(found).toContain("rule");
  });

  it("reads strong and emphasis spans", () => {
    const found = values("Isto é **forte** e isto é *ênfase*.", "md");
    expect(found).toEqual(["strong", "em"]);
  });

  it("reads bidi control characters by code point", () => {
    expect(values("a\u200Fb\u200Ec\u2066d\u2069", "bidi")).toEqual([
      "U+200F",
      "U+200E",
      "U+2066",
      "U+2069",
    ]);
  });

  it("counts fixed terms on word boundaries and ignores longer words", () => {
    const text = "DotBabel e DotBabelX; use OAuth, não OAuth2.";
    expect(values(text, "term", { preserve: ["DotBabel", "OAuth"] })).toEqual([
      "DotBabel",
      "OAuth",
    ]);
  });

  it("finds a fixed term next to a non-Latin letter", () => {
    expect(values("ثبّت Node.js الآن", "term", { preserve: ["Node.js"] })).toEqual(["Node.js"]);
  });
});

describe("compareProtectedTokens", () => {
  it("accepts identical text and text with only the prose changed", () => {
    const a = "Clique em <b>Salvar</b> para guardar {name}. Veja https://example.com/x.";
    const b = "Clique em <b>Salvar</b> para confirmar {name}. Veja https://example.com/x.";
    expect(compareProtectedTokens(a, a).ok).toBe(true);
    expect(compareProtectedTokens(a, b).ok).toBe(true);
  });

  it("accepts placeholders that move because the word order changed", () => {
    const a = "{user} enviou {count} mensagens";
    const b = "Foram enviadas {count} mensagens por {user}";
    expect(compareProtectedTokens(a, b).ok).toBe(true);
  });

  it("flags a dropped placeholder", () => {
    const result = compareProtectedTokens("Olá, {name}!", "Olá!");
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ kind: "placeholder", value: "{name}", count: 1 }]);
    expect(result.added).toEqual([]);
  });

  it("flags a translated placeholder name as one missing and one added token", () => {
    const result = compareProtectedTokens("Olá, {name}!", "Olá, {nome}!");
    expect(result.ok).toBe(false);
    expect(result.missing.map((t) => t.value)).toEqual(["{name}"]);
    expect(result.added.map((t) => t.value)).toEqual(["{nome}"]);
  });

  it("flags a lost # in a plural branch", () => {
    const result = compareProtectedTokens(
      "{n, plural, one {# item} other {# itens}}",
      "{n, plural, one {um item} other {vários itens}}",
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ kind: "icu-hash", value: "#", count: 2 }]);
  });

  it("flags a changed href, but accepts a translated alt text", () => {
    const original = '<a href="https://example.com/a">x</a> <img alt="Foto" src="a.png">';
    const alt = '<a href="https://example.com/a">y</a> <img alt="Photo" src="a.png">';
    const href = '<a href="https://example.com/b">y</a> <img alt="Foto" src="a.png">';
    expect(compareProtectedTokens(original, alt).ok).toBe(true);
    expect(compareProtectedTokens(original, href).ok).toBe(false);
  });

  it("flags a translated code span", () => {
    const result = compareProtectedTokens("Rode `dotbabel doctor`.", "Rode `dotbabel médico`.");
    expect(result.ok).toBe(false);
    expect(result.missing[0].kind).toBe("code-span");
  });

  it("flags a lost Markdown list item and a lost heading level", () => {
    expect(compareProtectedTokens("- a\n- b\n", "- a e b\n").ok).toBe(false);
    expect(compareProtectedTokens("## A\n", "# A\n").ok).toBe(false);
  });

  it("flags an altered fixed term", () => {
    const result = compareProtectedTokens("Use o OAuth aqui.", "Use a autorização aqui.", {
      preserve: ["OAuth"],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ kind: "term", value: "OAuth", count: 1 }]);
  });

  it("warns, but does not fail, when a bidi mark is added after a Latin token", () => {
    const result = compareProtectedTokens("ثبّت Node.js.", "ثبّت Node.js\u200F.");
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/U\+200F/);
  });

  it("fails when a bidi mark lands inside a placeholder", () => {
    const result = compareProtectedTokens("عدد: {count}", "عدد: {cou\u200Ent}");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("\\u200E");
  });

  it("fails when the revision breaks the ICU syntax", () => {
    const result = compareProtectedTokens(
      "{n, plural, one {# a} other {# b}}",
      "{n, plural, one {# a} other {# b}",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/ICU/);
  });

  it("does not blame the revision for ICU problems the original already had", () => {
    const result = compareProtectedTokens("texto {nome", "outro texto {nome");
    expect(result.errors).toEqual([]);
  });

  it("fails on added plural categories unless they are explicitly allowed", () => {
    const a = "{n, plural, one {um} other {# itens}}";
    const b = "{n, plural, one {um} few {# itens} many {# itens} other {# itens}}";
    expect(compareProtectedTokens(a, b).ok).toBe(false);
    const relaxed = compareProtectedTokens(a, b, { allowPluralCategories: true });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.warnings.join(" ")).toMatch(/plural/);
  });

  it("still fails on a changed argument name when plural categories are allowed", () => {
    const result = compareProtectedTokens(
      "{n, plural, one {um} other {# itens}}",
      "{total, plural, one {um} other {# itens}}",
      { allowPluralCategories: true },
    );
    expect(result.ok).toBe(false);
  });
});

const GOOD_FINDING = {
  id: "F1",
  location: "checkout.error",
  original: "Opa, deu ruim na sua transferência!",
  suggestion: "Não foi possível concluir a transferência.",
  category: "register",
  severity: "major",
  confidence: "high",
  explanation: "The tone is too casual for a banking error and blames no one in the revision.",
};

function review(overrides = {}) {
  return {
    language: "pt-BR",
    verdict: "needs-revision",
    findings: [{ ...GOOD_FINDING }],
    disclaimer: "AI-assisted review. It does not replace a native-speaking editor.",
    ...overrides,
  };
}

function codes(doc, opts) {
  return validateReviewDocument(doc, opts).errors.map((e) => e.code);
}

describe("validateReviewDocument", () => {
  it("publishes enumerations that cover the ten assessed dimensions", () => {
    for (const c of [
      "naturalness",
      "idiom",
      "lexical-choice",
      "syntax",
      "register",
      "cohesion",
      "regional-fit",
      "fidelity",
      "artificial-style",
      "clarity",
    ]) {
      expect(CATEGORIES).toContain(c);
    }
    expect(SEVERITIES).toEqual(["critical", "major", "minor", "preference"]);
    expect(CONFIDENCES).toEqual(["high", "medium", "low"]);
    expect(VERDICTS).toEqual(["natural", "minor-polish", "needs-revision"]);
  });

  it("accepts a complete review", () => {
    expect(validateReviewDocument(review())).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts a natural verdict with no findings", () => {
    expect(validateReviewDocument(review({ verdict: "natural", findings: [] })).ok).toBe(true);
  });

  it("rejects a review whose only findings are preferences: the text is natural", () => {
    const only = { ...GOOD_FINDING, severity: "preference", confidence: "medium" };
    expect(codes(review({ verdict: "natural", findings: [only] }))).toContain("preference-only");
    expect(codes(review({ verdict: "minor-polish", findings: [only] }))).toContain(
      "preference-only",
    );
  });

  it("allows a preference beside a real finding", () => {
    const real = { ...GOOD_FINDING, severity: "minor" };
    const alt = { ...GOOD_FINDING, id: "F2", severity: "preference", confidence: "medium" };
    const doc = review({ verdict: "minor-polish", findings: [real, alt] });
    expect(validateReviewDocument(doc).ok).toBe(true);
  });

  it("rejects a document that is not an object, or has no findings array", () => {
    expect(codes(null)).toContain("invalid-document");
    expect(codes([])).toContain("invalid-document");
    expect(codes(review({ findings: "none" }))).toContain("invalid-findings");
  });

  it("requires a language, a verdict from the list, and a disclaimer", () => {
    expect(codes(review({ language: "" }))).toContain("missing-field");
    expect(codes(review({ language: "Portuguese" }))).toContain("invalid-language");
    expect(codes(review({ verdict: "great" }))).toContain("invalid-enum");
    expect(codes(review({ disclaimer: " " }))).toContain("missing-field");
  });

  it("requires every finding field", () => {
    for (const field of [
      "original",
      "suggestion",
      "category",
      "severity",
      "confidence",
      "explanation",
    ]) {
      const finding = { ...GOOD_FINDING };
      delete finding[field];
      const result = validateReviewDocument(review({ findings: [finding] }));
      expect(result.ok, field).toBe(false);
      expect(result.errors[0].path).toContain(`findings[0].${field}`);
    }
  });

  it("rejects values outside the enumerations", () => {
    for (const [field, value] of [
      ["category", "spelling"],
      ["severity", "blocker"],
      ["confidence", "certain"],
    ]) {
      const doc = review({ findings: [{ ...GOOD_FINDING, [field]: value }] });
      expect(codes(doc), field).toContain("invalid-enum");
    }
  });

  it("rejects a suggestion that equals the original", () => {
    const doc = review({ findings: [{ ...GOOD_FINDING, suggestion: GOOD_FINDING.original }] });
    expect(codes(doc)).toContain("identical-suggestion");
  });

  it("requires the uncertainty to be stated when confidence is low", () => {
    const low = { ...GOOD_FINDING, confidence: "low" };
    expect(codes(review({ findings: [low] }))).toContain("missing-uncertainty");
    const stated = { ...low, uncertainty: "Both forms occur; check with a native editor." };
    expect(validateReviewDocument(review({ verdict: "minor-polish", findings: [stated] })).ok).toBe(
      true,
    );
  });

  it("ties the verdict to the findings", () => {
    const major = { ...GOOD_FINDING, severity: "major" };
    const minor = { ...GOOD_FINDING, severity: "minor" };
    expect(codes(review({ verdict: "natural", findings: [major] }))).toContain("verdict-mismatch");
    expect(codes(review({ verdict: "natural", findings: [minor] }))).toContain("verdict-mismatch");
    expect(codes(review({ verdict: "minor-polish", findings: [major] }))).toContain(
      "verdict-mismatch",
    );
    expect(codes(review({ verdict: "minor-polish", findings: [] }))).toContain("verdict-mismatch");
    expect(codes(review({ verdict: "needs-revision", findings: [minor] }))).toContain(
      "verdict-mismatch",
    );
    expect(validateReviewDocument(review({ verdict: "minor-polish", findings: [minor] })).ok).toBe(
      true,
    );
  });

  it("does not let a low-confidence finding turn the whole verdict into needs-revision", () => {
    const unsure = {
      ...GOOD_FINDING,
      severity: "major",
      confidence: "low",
      uncertainty: "Usage varies; check with a native editor.",
    };
    expect(codes(review({ verdict: "needs-revision", findings: [unsure] }))).toContain(
      "verdict-mismatch",
    );
    expect(validateReviewDocument(review({ verdict: "minor-polish", findings: [unsure] })).ok).toBe(
      true,
    );
    const critical = { ...unsure, severity: "critical" };
    expect(
      validateReviewDocument(review({ verdict: "minor-polish", findings: [critical] })).ok,
    ).toBe(true);
  });

  it("checks that each suggestion keeps the protected tokens of its original", () => {
    const finding = {
      ...GOOD_FINDING,
      original: "Olá, {name}! Veja `dotbabel doctor`.",
      suggestion: "Oi, {nome}! Veja `dotbabel doctor`.",
    };
    const result = validateReviewDocument(review({ findings: [finding] }));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("protected-token");
    expect(result.errors.find((e) => e.code === "protected-token").path).toBe(
      "findings[0].suggestion",
    );
  });

  it("applies document-level and caller-level fixed terms", () => {
    const finding = {
      ...GOOD_FINDING,
      original: "Pague com o Stripe.",
      suggestion: "Pague com a operadora.",
    };
    expect(codes(review({ findings: [finding], preserve: ["Stripe"] }))).toContain(
      "protected-token",
    );
    expect(codes(review({ findings: [finding] }), { preserve: ["Stripe"] })).toContain(
      "protected-token",
    );
    expect(validateReviewDocument(review({ findings: [finding] })).ok).toBe(true);
  });

  it("accepts left_alone as a list of strings, and rejects other shapes", () => {
    const ok = review({ left_alone: ["Bare infinitives on buttons are the normal convention."] });
    expect(validateReviewDocument(ok).ok).toBe(true);
    expect(codes(review({ left_alone: "text" }))).toContain("invalid-left-alone");
    expect(codes(review({ left_alone: [""] }))).toContain("invalid-left-alone");
  });

  it("requires assumptions, when present, to be an object of strings", () => {
    expect(validateReviewDocument(review({ assumptions: { audience: "shoppers" } })).ok).toBe(true);
    expect(codes(review({ assumptions: ["shoppers"] }))).toContain("invalid-assumptions");
    expect(codes(review({ assumptions: { audience: 3 } }))).toContain("invalid-assumptions");
  });

  it("accepts a location list for grouped findings, and rejects a malformed one", () => {
    const grouped = { ...GOOD_FINDING, location: undefined, locations: ["a.title", "b.title"] };
    expect(validateReviewDocument(review({ findings: [grouped] })).ok).toBe(true);
    const bad = { ...GOOD_FINDING, locations: "a.title" };
    expect(codes(review({ findings: [bad] }))).toContain("invalid-location");
  });
});

describe("check-review CLI", () => {
  function run(args, input) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      input,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function files(entries) {
    const dir = makeTempDir("language-review-");
    const paths = {};
    for (const [name, content] of Object.entries(entries)) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      paths[name] = file;
    }
    return { dir, paths };
  }

  it("prints usage and exits 64 without a command", () => {
    const result = run([]);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/preserve/);
  });

  it("exits 64 on an unknown flag", () => {
    expect(run(["preserve", "--bogus"]).status).toBe(64);
  });

  it("preserve: exits 0 when the tokens survive", () => {
    const { paths } = files({ "a.txt": "Olá, {name}!", "b.txt": "Oi, {name}!" });
    const result = run(["preserve", "--original", paths["a.txt"], "--revised", paths["b.txt"]]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ok/i);
  });

  it("preserve: exits 1 and names the lost token", () => {
    const { paths } = files({ "a.txt": "Olá, {name}!", "b.txt": "Olá!" });
    const result = run(["preserve", "--original", paths["a.txt"], "--revised", paths["b.txt"]]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("{name}");
  });

  it("preserve: reads one side from stdin, honours --preserve, and emits JSON", () => {
    const { paths } = files({ "a.txt": "Use OAuth." });
    const result = run(
      ["preserve", "--original", paths["a.txt"], "--revised", "-", "--preserve", "OAuth", "--json"],
      "Use autorização.",
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.missing[0]).toMatchObject({ kind: "term", value: "OAuth" });
  });

  it("preserve: honours --allow-plural-categories", () => {
    const { paths } = files({
      "a.txt": "{n, plural, one {um} other {# itens}}",
      "b.txt": "{n, plural, one {um} few {# itens} other {# itens}}",
    });
    const args = ["preserve", "--original", paths["a.txt"], "--revised", paths["b.txt"]];
    expect(run(args).status).toBe(1);
    expect(run([...args, "--allow-plural-categories"]).status).toBe(0);
  });

  it("validate: exits 0 for a good review on stdin", () => {
    const result = run(["validate", "-"], JSON.stringify(review()));
    expect(result.status).toBe(0);
  });

  it("validate: exits 1 for a bad review and lists the error codes", () => {
    const bad = review({ verdict: "natural" });
    const result = run(["validate", "-", "--json"], JSON.stringify(bad));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors.map((e) => e.code)).toContain("verdict-mismatch");
  });

  it("validate: exits 1, not a crash, on input that is not JSON", () => {
    const result = run(["validate", "-"], "not json");
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/JSON/);
  });

  it("extract: lists the protected tokens of a text", () => {
    const { paths } = files({ "a.txt": "Olá, {name}! `x`" });
    const result = run(["extract", paths["a.txt"], "--json"]);
    expect(result.status).toBe(0);
    const kinds = JSON.parse(result.stdout).tokens.map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(["placeholder", "code-span"]));
  });

  it("exits 2 when an input file is missing", () => {
    expect(run(["extract", "/nonexistent/language-review.txt"]).status).toBe(2);
  });

  it("still runs when started through a symlink, as bootstrap installs it", () => {
    const dir = makeTempDir("language-review-link-");
    const link = join(dir, "check-review.mjs");
    symlinkSync(SCRIPT, link);
    const result = spawnSync(process.execPath, [link, "extract", "-", "--json"], {
      encoding: "utf8",
      input: "{name}",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tokens).toHaveLength(1);
  });
});
