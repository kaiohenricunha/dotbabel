#!/usr/bin/env node
/**
 * Minimal fake `gh` for criteria-cli.test.mjs. Driven entirely by env vars
 * so each test only has to set the responses it cares about; every other
 * call shape gets a harmless default. Never shells out to the real `gh`.
 *
 * CommonJS on purpose, and installed on PATH under the extensionless name
 * `gh`: a shebang-executed extensionless file's module type is decided by
 * the nearest package.json, which this fixture directory does not control,
 * so ESM `import` here would risk resolving as CommonJS instead and fail.
 */
const fs = require("fs");

const args = process.argv.slice(2);
const joined = args.join(" ");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function log(line) {
  if (process.env.FAKE_GH_POST_LOG) fs.appendFileSync(process.env.FAKE_GH_POST_LOG, `${line}\n`);
}

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(`${process.env.FAKE_GH_REPO ?? "test-owner/test-repo"}\n`);
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(
    JSON.stringify({
      headRefOid: process.env.FAKE_GH_HEAD_SHA ?? "",
      baseRefOid: process.env.FAKE_GH_BASE_SHA ?? "",
      isCrossRepository: process.env.FAKE_GH_IS_FORK === "1",
      body: process.env.FAKE_GH_BODY ?? "",
    }),
  );
} else if (/^api user\b/.test(joined)) {
  process.stdout.write(`${process.env.FAKE_GH_LOGIN ?? "tester"}\n`);
} else if (/^api repos\/\S+\/issues\/\d+\/comments --paginate$/.test(joined)) {
  process.stdout.write(process.env.FAKE_GH_COMMENTS_JSON ?? "[]");
} else if (/^api --method POST repos\/\S+\/issues\/\d+\/comments --input -$/.test(joined)) {
  readStdin();
  log(joined);
  process.stdout.write(JSON.stringify({ id: 999, node_id: "IC_fake" }));
} else if (/^api graphql\b/.test(joined)) {
  log(joined);
  process.stdout.write(JSON.stringify({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }));
} else if (/^api repos\/\S+\/commits\/[0-9a-f]+ --jq \.author\.login$/.test(joined)) {
  process.stdout.write(`${process.env.FAKE_GH_COMMIT_AUTHOR ?? ""}\n`);
} else if (/^api repos\/\S+\/collaborators\/\S+\/permission --jq \.permission$/.test(joined)) {
  process.stdout.write(`${process.env.FAKE_GH_PERMISSION ?? "ADMIN"}\n`);
} else {
  process.stderr.write(`fake-gh: unhandled invocation: ${joined}\n`);
  process.exit(1);
}
