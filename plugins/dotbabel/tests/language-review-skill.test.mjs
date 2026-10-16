// Structural contract for the language-review skill.
//
// Everything here is deterministic: it reads the authored files and the
// fixtures and checks their shape. No test asserts that a model produces a
// particular edit; that part of the skill is judgment and is reviewed by people.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "../src/build-index.mjs";
import {
  CATEGORIES,
  CONFIDENCES,
  SEVERITIES,
  VERDICTS,
  compareProtectedTokens,
  validateReviewDocument,
} from "../../../skills/language-review/scripts/check-review.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SKILL_DIR = join(REPO_ROOT, "skills", "language-review");
const FIXTURE_DIR = join(__dirname, "fixtures", "language-review");

/** Locale tag -> reference file basename. The file names follow docs/taxonomy.md (kebab-case). */
const LOCALES = {
  en: "en",
  "pt-BR": "pt-br",
  es: "es",
  fr: "fr",
  de: "de",
  ar: "ar",
  "id-ID": "id-id",
};

const LOCALE_SECTIONS = [
  "Scope and variants",
  "Register and address",
  "What reads as native",
  "Transfer errors and calques",
  "Orthography, punctuation and typography",
  "Examples",
  "Leave alone",
  "Verify before ruling",
];

const DIMENSIONS = [
  "Naturalness",
  "Idiomaticity",
  "Lexical choice",
  "Syntax",
  "Register and tone",
  "Fluency and cohesion",
  "Cultural and regional fit",
  "Meaning preservation",
  "Artificial-sounding writing",
  "Clarity and concision",
];

function read(...parts) {
  return readFileSync(join(SKILL_DIR, ...parts), "utf8");
}

function headings(markdown, level) {
  const prefix = "#".repeat(level) + " ";
  return markdown
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

/** The text between a heading and the next heading of the same or higher level. */
function section(markdown, level, title) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l === `${"#".repeat(level)} ${title}`);
  if (start === -1) return "";
  const stop = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, stop === -1 ? undefined : stop).join("\n");
}

function tableRows(text) {
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .slice(2);
}

const skillText = read("SKILL.md");
const { frontmatter, body } = parseFrontmatter(skillText);

describe("language-review frontmatter contract", () => {
  it("is a draft writing/review skill with a matching id", () => {
    expect(frontmatter.id).toBe("language-review");
    expect(frontmatter.name).toBe("language-review");
    expect(frontmatter.type).toBe("skill");
    expect(frontmatter.domain).toEqual(["writing"]);
    expect(frontmatter.task).toEqual(["review"]);
    expect(frontmatter.platform).toEqual(["none"]);
    expect(frontmatter.maturity).toBe("draft");
  });

  it("cannot write: no write-capable tool is granted", () => {
    const granted = `${frontmatter.tools} ${frontmatter["allowed-tools"]}`;
    for (const tool of ["Write", "Edit", "Bash", "NotebookEdit"]) {
      expect(granted, tool).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
    expect(granted).toMatch(/\bRead\b/);
  });

  it("is model-invocable and user-invocable, because it is read-only", () => {
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(frontmatter["user-invocable"]).toBe(true);
  });

  it("states its triggers and stays inside the description length limit", () => {
    expect(frontmatter.description).toMatch(/Triggers on:/);
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
  });

  it("has an argument hint that names the language flag", () => {
    expect(frontmatter["argument-hint"]).toMatch(/--lang/);
  });
});

describe("language-review skill body", () => {
  it("stays small enough to be the whole contract for Copilot, which receives no references", () => {
    expect(skillText.split("\n").length).toBeLessThanOrEqual(300);
  });

  it("declares itself read-only and not a native-speaker validation", () => {
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/native[- ]speak/i);
    expect(body).toMatch(/not (?:a )?(?:substitute|replacement)|does not replace/i);
  });

  it("routes every supported locale to an existing reference file", () => {
    const rows = body.split("\n").filter((l) => /\]\(references\/[^)]+\.md\)/.test(l));
    const routed = {};
    for (const row of rows) {
      const file = row.match(/\]\(references\/([^)]+)\.md\)/)[1];
      routed[file] = row;
    }
    for (const [tag, file] of Object.entries(LOCALES)) {
      expect(routed[file], `row for ${file}`).toBeDefined();
      expect(routed[file], `tag ${tag} in the ${file} row`).toContain(`\`${tag}\``);
      expect(existsSync(join(SKILL_DIR, "references", `${file}.md`))).toBe(true);
    }
  });

  it("links only to files that exist", () => {
    const links = [...body.matchAll(/\]\(((?:references|examples|scripts)\/[^)#]+)\)/g)].map(
      (m) => m[1],
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of new Set(links)) {
      expect(existsSync(join(SKILL_DIR, link)), link).toBe(true);
    }
  });

  it("lists every enumeration value the validator accepts", () => {
    for (const value of [...CATEGORIES, ...SEVERITIES, ...CONFIDENCES, ...VERDICTS]) {
      expect(body, value).toContain(`\`${value}\``);
    }
  });

  it("names the ten assessed dimensions", () => {
    for (const dimension of DIMENSIONS) {
      expect(body.toLowerCase(), dimension).toContain(dimension.toLowerCase());
    }
  });

  it("tells the reviewer to preserve markup and to leave natural text alone", () => {
    expect(body).toMatch(/placeholder/i);
    expect(body).toMatch(/ICU/);
    expect(body).toMatch(/no findings|already natural|do not manufacture/i);
    expect(body).toMatch(/casual/i);
  });
});

describe("language-review references", () => {
  it("ships the rubric, the output contract, and the sources", () => {
    for (const file of ["editorial-rubric.md", "output-contract.md", "sources.md"]) {
      expect(existsSync(join(SKILL_DIR, "references", file)), file).toBe(true);
    }
    expect(existsSync(join(SKILL_DIR, "examples", "review-examples.md"))).toBe(true);
  });

  it("has exactly one reference per supported locale, and no stray locale files", () => {
    const files = readdirSync(join(SKILL_DIR, "references")).sort();
    const expected = [
      ...Object.values(LOCALES).map((f) => `${f}.md`),
      "editorial-rubric.md",
      "output-contract.md",
      "sources.md",
    ].sort();
    expect(files).toEqual(expected);
  });

  for (const [tag, file] of Object.entries(LOCALES)) {
    describe(`${tag} reference`, () => {
      const text = read("references", `${file}.md`);

      it("names its locale in the title", () => {
        expect(headings(text, 1)[0]).toContain(tag);
      });

      it("has the shared section set, in order", () => {
        expect(headings(text, 2)).toEqual(LOCALE_SECTIONS);
      });

      it("gives at least six off/better example pairs with a reason", () => {
        const rows = tableRows(section(text, 2, "Examples"));
        expect(rows.length).toBeGreaterThanOrEqual(6);
        for (const row of rows) {
          const cells = row.split("|").slice(1, -1);
          expect(cells.length, row).toBe(3);
          for (const cell of cells) expect(cell.trim().length, row).toBeGreaterThan(0);
        }
      });

      it("separates what is not an error from what is", () => {
        expect(section(text, 2, "Leave alone").trim().length).toBeGreaterThan(200);
        expect(section(text, 2, "Verify before ruling").trim().length).toBeGreaterThan(150);
      });
    });
  }

  it("keeps the shared rubric free of language-specific rules", () => {
    const rubric = read("references", "editorial-rubric.md");
    expect(headings(rubric, 3).filter((h) => DIMENSIONS.includes(h))).toEqual(DIMENSIONS);
    for (const word of ["gerundismo", "Deppenleerzeichen", "voseo", "idafa"]) {
      expect(rubric.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("keeps the output contract and the validator on one set of enumerations", () => {
    const contract = read("references", "output-contract.md");
    const fromTable = (title) =>
      tableRows(section(contract, 3, title)).map((row) => row.match(/`([^`]+)`/)?.[1]);
    expect(fromTable("Categories")).toEqual(CATEGORIES);
    expect(fromTable("Severities")).toEqual(SEVERITIES);
    expect(fromTable("Confidence")).toEqual(CONFIDENCES);
    expect(fromTable("Verdicts")).toEqual(VERDICTS);
  });

  it("records provenance and states that no upstream text is vendored", () => {
    const sources = read("references", "sources.md");
    expect(sources).toMatch(/i18nstack/);
    expect(sources).toMatch(/MIT/);
    expect(sources).toMatch(/i18nagent\.ai/);
    expect(sources).toMatch(/Natural Portuguese Writer/);
    expect(sources).toMatch(
      /not (?:vendored|copied)|nothing (?:is )?(?:vendored|copied)|no text (?:is )?(?:vendored|copied)/i,
    );
  });

  it("has a worked example for every supported locale", () => {
    const examples = read("examples", "review-examples.md");
    const titles = headings(examples, 3).join("\n");
    for (const tag of Object.keys(LOCALES)) {
      expect(titles, tag).toContain(tag);
    }
  });
});

function fencedBlocks(markdown, lang) {
  return [...markdown.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map(
    (m) => m[1],
  );
}

describe("the documented reports follow the contract they document", () => {
  const documents = [
    ["examples/review-examples.md", read("examples", "review-examples.md")],
    ["references/output-contract.md", read("references", "output-contract.md")],
  ];

  for (const [name, text] of documents) {
    it(`${name}: every JSON review validates`, () => {
      const reviews = fencedBlocks(text, "json")
        .map((block) => JSON.parse(block))
        .filter((doc) => doc && typeof doc === "object" && "verdict" in doc);
      expect(reviews.length).toBeGreaterThan(0);
      for (const doc of reviews) {
        const result = validateReviewDocument(doc);
        expect(result.ok, JSON.stringify(result.errors)).toBe(true);
      }
    });
  }

  it("examples: every Markdown report uses the enumerations, ties its verdict to its findings, and ends with the limits line", () => {
    const reports = fencedBlocks(read("examples", "review-examples.md"), "text").filter((block) =>
      block.startsWith("Language review ·"),
    );
    expect(reports.length).toBeGreaterThanOrEqual(6);
    const covered = new Set();
    for (const report of reports) {
      const verdict = report.match(/^Verdict: (\S+)/m)?.[1];
      expect(VERDICTS, report).toContain(verdict);
      expect(report).toMatch(/^Limits: /m);
      covered.add(report.split(" · ")[1]);

      const findings = [...report.matchAll(/^F\d+ · (\S+) · (\S+) · (\S+) · /gm)];
      for (const [, category, severity, confidence] of findings) {
        expect(CATEGORIES).toContain(category);
        expect(SEVERITIES).toContain(severity);
        expect(CONFIDENCES).toContain(confidence);
      }
      const blocks = report.split(/^(?=F\d+ · )/m).slice(1);
      for (const block of blocks) {
        const confidence = block.match(/^F\d+ · \S+ · \S+ · (\S+)/)[1];
        if (confidence === "low") expect(block, block).toMatch(/^ {2}Unsure: /m);
        expect(block).toMatch(/^ {2}Original: /m);
        expect(block).toMatch(/^ {2}Suggested: /m);
        expect(block).toMatch(/^ {2}Why: /m);
      }
      const blocking = findings.some(
        ([, , severity, confidence]) =>
          (severity === "critical" || severity === "major") && confidence !== "low",
      );
      const minor = findings.some(
        ([, , severity, confidence]) =>
          severity === "minor" ||
          ((severity === "critical" || severity === "major") && confidence === "low"),
      );
      const expected = blocking ? "needs-revision" : minor ? "minor-polish" : "natural";
      if (verdict === "natural") expect(findings, report).toHaveLength(0);
      expect(verdict, report).toBe(expected);
    }
    // The seventh language, Spanish, is shown in the JSON format.
    const languages = new Set([...covered].map((c) => c.split("-")[0]));
    for (const language of ["en", "de", "id", "fr", "pt", "ar"]) {
      expect(languages.has(language), language).toBe(true);
    }
  });
});

/** Source lines that are not comments, so a word in a comment cannot trip a guard. */
function code(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

/** What the zero-dependency, read-only contract forbids in a script's source. */
function forbidden(source) {
  const found = [];
  const src = code(source);
  for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
    if (!/^node:(?:fs|url|path)$/.test(m[1])) found.push(`import ${m[1]}`);
  }
  if (/\bimport\s*\(|\brequire\s*\(|process\.binding|process\.dlopen/.test(src)) {
    found.push("dynamic load");
  }
  if (
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|child_process|node:(?:http|https|net|dgram|dns|tls|worker_threads)/.test(
      src,
    )
  ) {
    found.push("network or process");
  }
  if (
    /\b(?:writeFile|appendFile|mkdir|mkdtemp|unlink|rm|rmdir|rename|copyFile|cp|truncate|symlink|link|chmod|createWriteStream|writeSync|writev)(?:Sync)?\s*\(/.test(
      src,
    )
  ) {
    found.push("file write");
  }
  return found;
}

describe("check-review.mjs stays inside the zero-dependency, read-only contract", () => {
  const source = read("scripts", "check-review.mjs");

  it("uses only the built-ins it needs, loads nothing dynamically, and writes no file", () => {
    expect(forbidden(source)).toEqual([]);
  });

  it("would notice a violation (the guard is not vacuous)", () => {
    expect(forbidden('const m = await import("child_process");')).toContain("dynamic load");
    expect(forbidden('import { execSync } from "child_process";')).toContain(
      "import child_process",
    );
    expect(forbidden('import("node:fs").then((fs) => fs.cpSync(a, b));')).toContain("dynamic load");
    expect(forbidden('import { writeFileSync } from "node:fs";\nwriteFileSync(p, d);')).toContain(
      "file write",
    );
    expect(forbidden("const r = await fetch(url);")).toContain("network or process");
    expect(forbidden("// mkdir and fetch( are only words in a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("language-review fixtures", () => {
  const CORE_SCENARIOS = [
    "unnatural-but-correct",
    "calque",
    "register-mismatch",
    "regional-inconsistency",
    "awkward-valid-structure",
    "natural-as-is",
    "artificial-style",
    "fixed-terminology",
    "localization-string",
  ];

  it("has one fixture file per supported locale", () => {
    const files = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toEqual(
      Object.values(LOCALES)
        .map((f) => `${f}.json`)
        .sort(),
    );
  });

  for (const [tag, file] of Object.entries(LOCALES)) {
    describe(`${tag} fixtures`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, `${file}.json`), "utf8"));

      it("declares a locale that belongs to this language", () => {
        expect(fixture.locale.split("-")[0]).toBe(tag.split("-")[0]);
      });

      it("covers every scenario the task names", () => {
        const present = new Set(fixture.cases.map((c) => c.scenario));
        for (const scenario of CORE_SCENARIOS) expect(present.has(scenario), scenario).toBe(true);
      });

      it("has unique case ids and a rationale for each case", () => {
        const ids = fixture.cases.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of fixture.cases) {
          expect(typeof c.note === "string" && c.note.length > 0, c.id).toBe(true);
          expect(typeof c.original === "string" && c.original.length > 0, c.id).toBe(true);
        }
      });

      it("keeps natural text unchanged and changes the text in every other case", () => {
        for (const c of fixture.cases) {
          if (c.scenario === "natural-as-is") expect(c.suggestion, c.id).toBeNull();
          else expect(c.suggestion, c.id).not.toBe(c.original);
        }
      });

      it("matches the expected preservation result for each case", () => {
        for (const c of fixture.cases) {
          const revised = c.suggestion ?? c.original;
          const options = { preserve: c.preserve ?? [] };
          const result = compareProtectedTokens(c.original, revised, options);
          expect(result.ok, c.id).toBe(c.expect.preserved);
          if (!c.expect.preserved) {
            const kinds = new Set([...result.missing, ...result.added].map((t) => t.kind));
            for (const kind of c.expect.violations)
              expect(kinds.has(kind), `${c.id}: ${kind}`).toBe(true);
          }
          if (c.expect.preservedWhenPluralCategoriesAllowed !== undefined) {
            const relaxed = compareProtectedTokens(c.original, revised, {
              ...options,
              allowPluralCategories: true,
            });
            expect(relaxed.ok, `${c.id} (plural categories allowed)`).toBe(
              c.expect.preservedWhenPluralCategoriesAllowed,
            );
          }
          if (c.expect.warnings) {
            expect(result.warnings.join(" "), c.id).toMatch(new RegExp(c.expect.warnings));
          }
        }
      });

      it("has review documents that validate as expected", () => {
        expect(fixture.reviews.length).toBeGreaterThanOrEqual(2);
        for (const r of fixture.reviews) {
          const result = validateReviewDocument(r.document);
          expect(result.ok, `${r.id}: ${JSON.stringify(result.errors)}`).toBe(r.expect.valid);
        }
        const verdicts = fixture.reviews.map((r) => r.document.verdict);
        expect(verdicts).toContain("natural");
        expect(verdicts).toContain("needs-revision");
      });
    });
  }

  it("covers Arabic right-to-left text with Latin tokens, a placeholder, and a directional mark", () => {
    const ar = JSON.parse(readFileSync(join(FIXTURE_DIR, "ar.json"), "utf8"));
    const rtl = ar.cases.filter((c) => c.scenario === "rtl-mixed");
    expect(rtl.length).toBeGreaterThanOrEqual(3);
    for (const c of ar.cases) expect(c.original, c.id).toMatch(/[؀-ۿ]/);
    expect(rtl.some((c) => /[A-Za-z]+\.js/.test(c.original))).toBe(true);
    expect(rtl.some((c) => /\u200F/.test(c.suggestion))).toBe(true);
    expect(rtl.some((c) => c.expect.preserved === false)).toBe(true);
  });
});
