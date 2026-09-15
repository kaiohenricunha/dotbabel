import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { verifyCriteria, parseJUnitText, junitNameMatches, dropPartialLastLine, computeTail, criterionNumber } from "../src/criteria/index.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8")).version;
const FIXTURES_DIR = path.join(__dirname, "fixtures", "criteria");

// Build an isolated repo with one spec.json declaring the given criteria, plus
// the named test files those criteria reference (so load.mjs's existence and
// name-containment checks pass unless a test deliberately omits one).
function makeRepo({ criteria, testFileContents = {} }) {
  const root = makeTempDir("criteria-verify-test-");
  const specDir = path.join(root, "docs", "specs", "example");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    path.join(specDir, "spec.json"),
    JSON.stringify(
      {
        id: "example",
        title: "Example",
        status: "approved",
        owners: ["Tester"],
        linked_paths: ["CLAUDE.md"],
        acceptance_commands: ["echo ok"],
        acceptance_criteria: criteria,
        depends_on_specs: [],
        active_prs: [],
      },
      null,
      2,
    ),
  );
  for (const [rel, contents] of Object.entries(testFileContents)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

function reportPathAbs(root, relPath) {
  return path.join(root, relPath);
}

// A tiny inline node script as argv, so every "command" a test declares is
// fully deterministic: exact exit code, exact stdout/stderr, and (optionally)
// a JUnit report it writes itself.
function nodeScriptArgv(script) {
  return [NODE, "-e", script];
}

function junitReport({ tests, suiteName = "suite" }) {
  const cases = tests
    .map((t) => {
      if (t.outcome === "failed") return `<testcase classname="${suiteName}" name="${t.name}"><failure message="boom">boom</failure></testcase>`;
      if (t.outcome === "error") return `<testcase classname="${suiteName}" name="${t.name}"><error message="boom">boom</error></testcase>`;
      if (t.outcome === "skipped") return `<testcase classname="${suiteName}" name="${t.name}"><skipped/></testcase>`;
      return `<testcase classname="${suiteName}" name="${t.name}" />`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="${suiteName}" tests="${tests.length}">${cases}</testsuite></testsuites>`;
}

describe("verifyCriteria", () => {
  it("passes a criterion only when the command exits 0 and every named test is confirmed", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "it passes" }],
          argv: nodeScriptArgv("process.stdout.write('it passes\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// it passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.verdict).toBe("pass");
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
  });

  it("fails a criterion when the command exits non-zero", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "it passes" }],
          argv: nodeScriptArgv("process.stdout.write('it passes\\n'); process.exit(1)"),
        },
      ],
      testFileContents: { "t.mjs": "// it passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("fail");
    expect(result.payload.verdict).toBe("fail");
  });

  it("marks a criterion unconfirmed when the command exits 0 but a named test is missing from the output", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "it passes" }],
          argv: nodeScriptArgv("process.stdout.write('nothing relevant\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// it passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
  });

  it("confirms named tests from a JUnit XML report by exact or suffix name match", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "suite > passes", outcome: "passed" }] }))})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
    expect(result.payload.specs[0].criteria[0].tests[0].confirmed_by).toBe("junit");
  });

  it("fails a criterion when a JUnit testcase for a named test has a failure element", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "passes", outcome: "failed" }] }))})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("fail");
  });

  it("marks a criterion unconfirmed when a JUnit testcase for a named test is skipped", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "passes", outcome: "skipped" }] }))})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
  });

  it("reports error when a named test file does not exist", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "missing.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.exit(0)"),
        },
      ],
      testFileContents: {},
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  });

  it("reports error when a test name does not appear in its file", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "does not exist in file" }],
          argv: nodeScriptArgv("process.exit(0)"),
        },
      ],
      testFileContents: { "t.mjs": "// some other content" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  });

  it("reports error when the JUnit report was not rewritten by this run", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.exit(0)"), // never writes report.xml
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    // A stale report from a hypothetical earlier run must not survive.
    writeFileSync(reportPathAbs(root, "report.xml"), junitReport({ tests: [{ name: "passes", outcome: "passed" }] }));
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    // Precisely the "not rewritten" guard, not merely some other error: a
    // stale report the deleted-then-never-rewritten file could otherwise
    // still be read back as if it were fresh.
    expect(result.payload.specs[0].criteria[0].error_message).toMatch(/not rewritten/);
  });

  it("reports error, rather than reading outside the repository, for a tests[].file that traverses out", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "../../../../etc/passwd", name: "passes" }],
          argv: nodeScriptArgv("process.exit(0)"),
        },
      ],
      testFileContents: {},
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].error_message).toMatch(/escapes the repository/);
  });

  it("reports error, rather than deleting outside the repository, for a report.path that traverses out", async () => {
    const outside = makeTempDir("criteria-verify-outside-");
    const sentinel = path.join(outside, "sentinel.xml");
    writeFileSync(sentinel, "do not delete me");
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.exit(0)"),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    // Rewrite report.path to a "../"-relative path that still escapes the
    // repository once joined onto it — the exact shape spec.json carries,
    // not an absolute path a different check might catch instead.
    const specPath = path.join(root, "docs", "specs", "example", "spec.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    spec.acceptance_criteria[0].report.path = path.relative(root, sentinel);
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].error_message).toMatch(/escapes the repository/);
    expect(readFileSync(sentinel, "utf8")).toBe("do not delete me");
  });

  it("reports error, rather than throwing, when a criterion's argv is missing or empty", async () => {
    const root = makeRepo({
      criteria: [
        { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "passes" }], argv: [] },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].error_message).toMatch(/argv/);
  });

  it("rejects a JUnit report that declares a DOCTYPE", async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY x "y">]><testsuites><testsuite><testcase name="passes"/></testsuite></testsuites>`;
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(evil)})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  });

  it("does not expand an entity reference in a JUnit report", async () => {
    const withEntity = `<?xml version="1.0"?><testsuites><testsuite><testcase name="&unknown; passes"/></testsuite></testsuites>`;
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(withEntity)})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    // The unresolved literal "&unknown; passes" does not end with "passes"
    // after the suffix rule (no `>`, `::`, `.`, `/` precedes it), and it is
    // not an exact match either, so the test stays unconfirmed rather than
    // matching through an expanded entity.
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
  });

  it("rejects a JUnit report larger than 10 MiB without reading past the limit", async () => {
    // Otherwise well-formed and parseable — one real passing "passes"
    // testcase, padded past the limit with a giant XML comment — so that if
    // the size check were bypassed, parsing would actually succeed instead
    // of failing for some unrelated reason, and the test would then fail to
    // notice the size check was gone.
    const script = [
      "const fs = require('fs');",
      "const head = '<?xml version=\"1.0\"?><testsuites><testsuite><testcase name=\"passes\"/><!--';",
      "const tail = '--></testsuite></testsuites>';",
      "const padLen = 11 * 1024 * 1024 - head.length - tail.length;",
      "fs.writeFileSync('report.xml', head + 'x'.repeat(padLen) + tail);",
    ].join(" ");
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(script),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].error_message).toMatch(/10 MiB/);
  });

  it("reports error for a malformed JUnit report", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("require('fs').writeFileSync('report.xml', 'this is not xml at all')"),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  });

  it("refuses to run a criterion command without project-command trust", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stdout.write('passes\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    await expect(verifyCriteria(ctx, { specId: "example", allowProjectCommands: false, env: {} })).rejects.toMatchObject({
      code: ERROR_CODES.QUALITY_TRUST_REQUIRED,
    });
  });

  it("does not delete a configured report before the trust check rejects the run", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stdout.write('passes\\n')"),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    writeFileSync(reportPathAbs(root, "report.xml"), "pre-existing report, not deleted by an untrusted run");
    const ctx = createHarnessContext({ repoRoot: root });
    await expect(verifyCriteria(ctx, { specId: "example", allowProjectCommands: false, env: {} })).rejects.toMatchObject({
      code: ERROR_CODES.QUALITY_TRUST_REQUIRED,
    });
    expect(readFileSync(reportPathAbs(root, "report.xml"), "utf8")).toBe("pre-existing report, not deleted by an untrusted run");
  });

  it("runs each criterion command exactly once even when it fails", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(
            `const fs=require('fs'); const c=(fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8')):0)+1; fs.writeFileSync('count.txt', String(c)); process.exit(1)`,
          ),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(readFileSync(path.join(root, "count.txt"), "utf8")).toBe("1");
  });

  it("applies one shared execution result to every criterion with the same argv", async () => {
    const argv = nodeScriptArgv(
      `const fs=require('fs'); const c=(fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8')):0)+1; fs.writeFileSync('count.txt', String(c)); process.stdout.write('a passes\\nb passes\\n')`,
    );
    const root = makeRepo({
      criteria: [
        { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "a passes" }], argv },
        { id: "AC-2", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "b passes" }], argv },
      ],
      testFileContents: { "t.mjs": "// a passes\n// b passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(readFileSync(path.join(root, "count.txt"), "utf8")).toBe("1");
    const statuses = result.payload.specs[0].criteria.map((c) => c.status);
    expect(statuses).toEqual(["pass", "pass"]);
  });

  it("sets status error when a criterion command times out", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("setTimeout(() => {}, 60000)"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true, timeoutSeconds: 1 });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  }, 10000);

  it("records a planned criterion as pending without running it", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          status: "planned",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("require('fs').writeFileSync('ran.txt', '1')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("pending");
    expect(existsSync(path.join(root, "ran.txt"))).toBe(false);
  });

  it("records an unknown criterion status as an error without running it", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          status: "enabled",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("require('fs').writeFileSync('ran.txt', '1')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const result = await verifyCriteria(createHarnessContext({ repoRoot: root }), {
      specId: "example",
      allowProjectCommands: true,
    });
    expect(result.payload.specs[0].criteria[0]).toMatchObject({ status: "error", error_message: expect.stringMatching(/status/) });
    expect(existsSync(path.join(root, "ran.txt"))).toBe(false);
  });

  it("runs only the criteria named in criterionIds and leaves the others out of the payload", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "one" }],
          argv: nodeScriptArgv("require('fs').writeFileSync('ran-ac1.txt', '1'); process.stdout.write('one\\n')"),
        },
        { id: "AC-2", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "two" }], argv: nodeScriptArgv("process.stdout.write('two\\n')") },
        { id: "AC-3", status: "planned", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "three" }], argv: nodeScriptArgv("process.exit(0)") },
      ],
      testFileContents: { "t.mjs": "// one\n// two\n// three" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true, criterionIds: ["AC-2"] });
    expect(result.payload.specs[0].criteria.map((c) => c.id)).toEqual(["AC-2"]);
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
    expect(existsSync(path.join(root, "ran-ac1.txt"))).toBe(false);
  });

  it("records truncated true when an output stream reaches 1 MiB", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stdout.write('passes\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].truncated).toBe(true);
  });

  it("drops the last partial line of a truncated stream before redaction", async () => {
    // A secret-shaped token straddles the 1 MiB cut so the raw bytes end
    // mid-token; the finished line before it must still be visible, and the
    // dangling partial line must not leak an unredacted half-token.
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(
            "process.stdout.write('passes\\n'); process.stdout.write('x'.repeat(1024*1024 - 20)); process.stdout.write('\\nsk-' + 'a'.repeat(40))",
          ),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].truncated).toBe(true);
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
  });

  it("drops a truncated stream's dangling partial line even when stderr is empty (SEC-4)", async () => {
    // The declared test name sits only in the dangling line past the 1 MiB
    // cut — a complete filler line, then the name with no trailing newline,
    // then enough filler after it to push the total past the cap. If the
    // partial line is dropped per-stream (correct), the name is gone and the
    // criterion is unconfirmed; if it is only dropped from the concatenated
    // stdout+stderr string (the bug: with stderr empty, the inserted "\n"
    // separator becomes the "last newline" and nothing real is trimmed), the
    // name survives and the criterion wrongly reports pass.
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "dangling-fragment-test" }],
          argv: nodeScriptArgv(
            "process.stdout.write('x'.repeat(1000) + '\\n'); process.stdout.write('dangling-fragment-test'); process.stdout.write('y'.repeat(1024*1024))",
          ),
        },
      ],
      testFileContents: { "t.mjs": "// dangling-fragment-test" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].truncated).toBe(true);
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
  });

  it("never confirms a secret-shaped test name from output, because the runner's own redaction already removed it", async () => {
    const secretShapedName = "sk-" + "b".repeat(30);
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: secretShapedName }],
          argv: nodeScriptArgv(`process.stdout.write(${JSON.stringify(secretShapedName)} + '\\n')`),
        },
      ],
      testFileContents: { "t.mjs": `// ${secretShapedName}` },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
    expect(result.payload.specs[0].criteria[0].tests[0].result).toBe("absent");
  });

  it("truncates each output tail to 40 lines and 2000 characters after redaction", async () => {
    // The marker word is built at runtime (never a literal in the script
    // source), so it cannot leak into the payload via the stored `argv`
    // field itself — only via the tail text this assertion actually checks.
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(
            "for (let i = 0; i < 60; i++) process.stdout.write('mark' + 'er-' + i + '\\n'); process.stdout.write('passes\\n')",
          ),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
    // The tail is never stored as text — only its hash is.
    expect(result.payload.specs[0].criteria[0].output_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.payload)).not.toMatch(/marker-0\b/);
  });

  it("stores a SHA-256 hash of each output tail and no output text in the payload", async () => {
    // Built at runtime, same reasoning as the truncation test above: the
    // marker must appear only in the process's actual stdout, never as a
    // literal in the script source that also becomes the payload's argv.
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stdout.write(['sec' + 'ret', 'marker', 'xyz', 'passes'].join('-') + '\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    const criterion = result.payload.specs[0].criteria[0];
    expect(criterion.output_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.payload)).not.toMatch(/secret-marker-xyz/);
  });

  it("sets the payload verdict to pass only when every active criterion passes", async () => {
    const root = makeRepo({
      criteria: [
        { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "a" }], argv: nodeScriptArgv("process.stdout.write('a\\n')") },
        { id: "AC-2", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "b" }], argv: nodeScriptArgv("process.stdout.write('nope\\n')") },
      ],
      testFileContents: { "t.mjs": "// a\n// b" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.verdict).toBe("unconfirmed");
  });

  it("builds an identical payload apart from generated_at and duration_ms for the same inputs", async () => {
    const root = makeRepo({
      criteria: [
        { id: "AC-2", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "b" }], argv: nodeScriptArgv("process.stdout.write('b\\n')") },
        { id: "AC-1", given: "g", when: "w", then: "t", tests: [{ file: "t.mjs", name: "a" }], argv: nodeScriptArgv("process.stdout.write('a\\n')") },
      ],
      testFileContents: { "t.mjs": "// a\n// b" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const strip = (payload) => {
      const { generated_at, ...rest } = payload;
      return { ...rest, specs: rest.specs.map((s) => ({ ...s, criteria: s.criteria.map(({ duration_ms, ...c }) => c) })) };
    };
    const a = (await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true })).payload;
    const b = (await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true })).payload;
    expect(strip(a)).toEqual(strip(b));
    // Sorted by id even though AC-2 was declared first in spec.json (REL-5).
    expect(a.specs[0].criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
  });

  it("sorts a criterion's tests by file then name regardless of spec.json declaration order (REL-5)", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [
            { file: "z.mjs", name: "z passes" },
            { file: "a.mjs", name: "b passes" },
            { file: "a.mjs", name: "a passes" },
          ],
          argv: nodeScriptArgv("process.stdout.write('z passes\\nb passes\\na passes\\n')"),
        },
      ],
      testFileContents: { "z.mjs": "// z passes", "a.mjs": "// a passes\n// b passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].tests.map((t) => `${t.file}:${t.name}`)).toEqual(["a.mjs:a passes", "a.mjs:b passes", "z.mjs:z passes"]);
  });

  it("matches JUnit names for any generated test name and separator", async () => {
    for (const [reported, criterionName] of [
      ["suite > passes", "passes"],
      ["suite::passes", "passes"],
      ["suite.passes", "passes"],
      ["suite/passes", "passes"],
      ["passes", "passes"],
    ]) {
      const root = makeRepo({
        criteria: [
          {
            id: "AC-1",
            given: "g",
            when: "w",
            then: "t",
            tests: [{ file: "t.mjs", name: criterionName }],
            argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: reported, outcome: "passed" }] }))})`),
            report: { format: "junit-xml", path: "report.xml" },
          },
        ],
        testFileContents: { "t.mjs": `// ${criterionName}` },
      });
      const ctx = createHarnessContext({ repoRoot: root });
      const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
      expect(result.payload.specs[0].criteria[0].status, `reported="${reported}" criterion="${criterionName}"`).toBe("pass");
    }
  });

  it("treats an explicit open/close testcase tag with no failure, error, or skipped child as passed", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite><testcase name="passes"><system-out>ok</system-out></testcase></testsuite></testsuites>`;
    const { testcases } = parseJUnitText(xml);
    expect(testcases).toEqual([{ name: "passes", outcome: "passed" }]);
  });

  it("skips a testcase that has no name attribute", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite><testcase classname="c" /><testcase name="real" /></testsuite></testsuites>`;
    const { testcases } = parseJUnitText(xml);
    expect(testcases).toEqual([{ name: "real", outcome: "passed" }]);
  });

  it("decodes all five XML-predefined entities and a numeric character reference", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite><testcase name="&lt;a&gt; &amp; &apos;b&apos; &quot;c&quot; &#100;" /></testsuite></testsuites>`;
    const { testcases } = parseJUnitText(xml);
    expect(testcases[0].name).toBe(`<a> & 'b' "c" d`);
  });

  describe("real JUnit fixtures (P-B1 §6.3)", () => {
    // Each fixture is real, captured tool output (see fixtures/criteria/README.md),
    // not the inline junitReport() generator every other test in this file
    // uses — a closed loop between the parser and a hand-rolled generator
    // cannot catch a real tool's shape the parser mishandles, which is
    // exactly how the parser's two regex bugs (a raw `>` in an attribute
    // value, and an unanchored attribute-name match) were found during
    // development. These tests keep that check running on every change.
    function readFixture(name) {
      return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
    }

    it("parses the real Vitest fixture, resolving its '>' describe/it separator", () => {
      const { testcases } = parseJUnitText(readFixture("vitest-4.1.5.junit.xml"));
      expect(testcases).toEqual([
        { name: "sample > passes", outcome: "passed" },
        { name: "sample > fails", outcome: "failed" },
        { name: "sample > is skipped", outcome: "skipped" },
      ]);
      expect(junitNameMatches("sample > passes", "passes")).toBe(true);
    });

    it("parses the real pytest fixture, treating an uncaught exception as a failure not an error", () => {
      const { testcases } = parseJUnitText(readFixture("pytest-9.1.1.junit.xml"));
      expect(testcases).toEqual([
        { name: "test_passes", outcome: "passed" },
        { name: "test_fails", outcome: "failed" },
        { name: "test_errors", outcome: "failed" },
        { name: "test_skipped", outcome: "skipped" },
      ]);
    });

    it("parses the real go-junit-report fixture, including its CDATA failure and skipped bodies", () => {
      const { testcases } = parseJUnitText(readFixture("go-junit-report-2.1.0.junit.xml"));
      expect(testcases).toEqual([
        { name: "TestPasses", outcome: "passed" },
        { name: "TestFails", outcome: "failed" },
        { name: "TestSkipped", outcome: "skipped" },
      ]);
    });

    it("parses the real bats-core fixture, including its XML-entity-encoded failure text", () => {
      const { testcases } = parseJUnitText(readFixture("bats-core-1.13.0.junit.xml"));
      expect(testcases).toEqual([
        { name: "it passes", outcome: "passed" },
        { name: "it fails", outcome: "failed" },
        { name: "it is skipped", outcome: "skipped" },
      ]);
    });

    it("confirms a criterion end to end against each real fixture via parseJUnitReport", async () => {
      for (const [file, name] of [
        ["vitest-4.1.5.junit.xml", "sample > passes"],
        ["pytest-9.1.1.junit.xml", "test_passes"],
        ["go-junit-report-2.1.0.junit.xml", "TestPasses"],
        ["bats-core-1.13.0.junit.xml", "it passes"],
      ]) {
        const root = makeRepo({
          criteria: [
            {
              id: "AC-1",
              given: "g",
              when: "w",
              then: "t",
              tests: [{ file: "t.mjs", name }],
              argv: nodeScriptArgv(`require('fs').copyFileSync(${JSON.stringify(path.join(FIXTURES_DIR, file))}, 'report.xml')`),
              report: { format: "junit-xml", path: "report.xml" },
            },
          ],
          testFileContents: { "t.mjs": `// ${name}` },
        });
        const ctx = createHarnessContext({ repoRoot: root });
        const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
        expect(result.payload.specs[0].criteria[0].status, file).toBe("pass");
      }
    });
  });

  it("treats a testcase with an error element the same as a failure element", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(`require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "passes", outcome: "error" }] }))})`),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("fail");
  });

  it("sets status error when the criterion command cannot be spawned", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: ["definitely-not-a-real-binary-xyz", "--version"],
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
  });

  describe("dropPartialLastLine", () => {
    it("returns the text unchanged when not truncated", () => {
      expect(dropPartialLastLine("a\nb\nc", false)).toBe("a\nb\nc");
    });
    it("drops everything after the last newline when truncated", () => {
      expect(dropPartialLastLine("a\nb\nc-partial", true)).toBe("a\nb");
    });
    it("drops the whole text when truncated with no newline at all", () => {
      expect(dropPartialLastLine("no-newline-at-all", true)).toBe("");
    });
  });

  describe("computeTail", () => {
    it("returns the text unchanged when at or under the line and character limits", () => {
      expect(computeTail("a\nb\nc")).toBe("a\nb\nc");
    });
    it("keeps only the last 40 lines, dropping earlier ones", () => {
      const lines = Array.from({ length: 45 }, (_, i) => `l${i}`);
      const tail = computeTail(lines.join("\n"));
      expect(tail.split("\n")).toEqual(lines.slice(-40));
      expect(tail).not.toContain("l0\n");
    });
    it("keeps only the last 2000 characters when the joined lines exceed it", () => {
      const text = "x".repeat(3000);
      const tail = computeTail(text);
      expect(tail).toHaveLength(2000);
      expect(tail).toBe("x".repeat(2000));
    });
  });

  describe("criterionNumber", () => {
    it("reads the numeric suffix of a well-formed AC-<number> id", () => {
      expect(criterionNumber("AC-3")).toBe(3);
      expect(criterionNumber("AC-10")).toBe(10);
    });
    it("sorts a malformed id last rather than matching a substring", () => {
      // Anchoring at both ends matters: an unanchored match would read "3"
      // out of either of these, putting a malformed id ahead of AC-99.
      expect(criterionNumber("XAC-3")).toBe(Number.MAX_SAFE_INTEGER);
      expect(criterionNumber("AC-3-suffix")).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it("confirms a named test that appears only in stderr, not stdout", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stderr.write('passes\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("pass");
  });

  it("fails a criterion with two named tests when only one of them fails", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [
            { file: "t.mjs", name: "a" },
            { file: "t.mjs", name: "b" },
          ],
          argv: nodeScriptArgv(
            `require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "a", outcome: "passed" }, { name: "b", outcome: "failed" }] }))})`,
          ),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// a\n// b" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("fail");
  });

  it("builds the exact payload shape for a simple passing criterion", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("process.stdout.write('passes\\n')"),
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    const { generated_at, ...rest } = result.payload;
    const { duration_ms, ...criterion } = rest.specs[0].criteria[0];
    const payload = { ...rest, specs: [{ ...rest.specs[0], criteria: [criterion] }] };
    expect(typeof generated_at).toBe("string");
    expect(typeof duration_ms).toBe("number");
    expect(payload).toEqual({
      schema_version: 1,
      tool: { name: "dotbabel", version: PACKAGE_VERSION },
      verdict: "pass",
      specs: [
        {
          id: "example",
          criteria: [
            {
              id: "AC-1",
              status: "pass",
              argv: nodeScriptArgv("process.stdout.write('passes\\n')"),
              exit_code: 0,
              timed_out: false,
              truncated: false,
              tests: [{ file: "t.mjs", name: "passes", found_in_file: true, confirmed_by: "output", result: "passed" }],
              output_sha256: criterion.output_sha256,
            },
          ],
        },
      ],
    });
    expect(criterion.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a criterion truncated when its output truncated even though its JUnit report also failed to parse", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv(
            "require('fs').writeFileSync('report.xml', 'not xml'); process.stdout.write('x'.repeat(2 * 1024 * 1024))",
          ),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].truncated).toBe(true);
  });

  it("marks a criterion with two named tests unconfirmed when only one of them is skipped", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [
            { file: "t.mjs", name: "a" },
            { file: "t.mjs", name: "b" },
          ],
          argv: nodeScriptArgv(
            `require('fs').writeFileSync('report.xml', ${JSON.stringify(junitReport({ tests: [{ name: "a", outcome: "passed" }, { name: "b", outcome: "skipped" }] }))})`,
          ),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// a\n// b" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("unconfirmed");
  });

  it("does not mark a criterion truncated when its JUnit report fails to parse but its output did not truncate", async () => {
    const root = makeRepo({
      criteria: [
        {
          id: "AC-1",
          given: "g",
          when: "w",
          then: "t",
          tests: [{ file: "t.mjs", name: "passes" }],
          argv: nodeScriptArgv("require('fs').writeFileSync('report.xml', 'not xml')"),
          report: { format: "junit-xml", path: "report.xml" },
        },
      ],
      testFileContents: { "t.mjs": "// passes" },
    });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true });
    expect(result.payload.specs[0].criteria[0].status).toBe("error");
    expect(result.payload.specs[0].criteria[0].truncated).toBe(false);
  });

  it("verifies 50 criteria with at most 2 seconds of its own overhead", async () => {
    const criteria = Array.from({ length: 50 }, (_, i) => ({
      id: `AC-${i + 1}`,
      given: "g",
      when: "w",
      then: "t",
      tests: [{ file: "t.mjs", name: `test ${i}` }],
      argv: nodeScriptArgv(`process.stdout.write('test ${i}\\n')`),
    }));
    const root = makeRepo({ criteria, testFileContents: { "t.mjs": criteria.map((c) => `// ${c.tests[0].name}`).join("\n") } });
    const ctx = createHarnessContext({ repoRoot: root });
    const started = Date.now();
    const result = await verifyCriteria(ctx, { specId: "example", allowProjectCommands: true, jobs: 8 });
    const totalMs = Date.now() - started;
    const commandMs = result.payload.specs[0].criteria.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0);
    expect(result.payload.verdict).toBe("pass");
    // Node's own process-spawn cost dominates wall time for 50 tiny scripts;
    // the assertion is about this library's OWN overhead layered on top of
    // that unavoidable execution time, not total wall time.
    expect(totalMs - commandMs).toBeLessThan(2000);
  });
});
