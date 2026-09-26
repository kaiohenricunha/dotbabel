/**
 * The heavy-command detector of the `dotbabel fleet` CPU lanes: which shell
 * commands are test runs big enough to wait for a lane.
 *
 * No imports, on purpose. hooks/fleet-shell-prefix.sh starts Node for this
 * check on the path of every Bash tool command that names a test tool, so the
 * module must load in the time of a bare `node -e ''`.
 */

// ------------------------------------------------------------ scanning ----

/**
 * Split a shell command into simple commands, each a list of words with the
 * quotes removed. Scanning stops at a heredoc (`<<`), because the lines after
 * it are data, not commands. Returns null for text with an unclosed quote.
 */
function splitCommands(src) {
  const segments = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? "") + src.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
          buf += src[j + 1];
          j += 2;
        } else {
          buf += src[j];
          j += 1;
        }
      }
      if (j >= src.length) return null;
      word = (word ?? "") + buf;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 < src.length && src[i + 1] !== "\n") word = (word ?? "") + src[i + 1];
      i += 2;
    } else if (c === "#" && word === null) {
      const eol = src.indexOf("\n", i);
      i = eol < 0 ? src.length : eol;
    } else if (c === "<" && src[i + 1] === "<") {
      if (src[i + 2] === "<") {
        endWord();
        i += 3;
      } else {
        endSegment();
        return segments;
      }
    } else if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">")) {
      word = (word ?? "") + c; // a redirection such as 2>&1 or &>file
      i += 1;
    } else if (c === "$" && src[i + 1] === "(") {
      endSegment();
      i += 2;
    } else if (";&|()\n`".includes(c)) {
      endSegment();
      i += 1;
    } else if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else {
      word = (word ?? "") + c;
      i += 1;
    }
  }
  endSegment();
  return segments;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "exec", "command", "builtin", "nohup", "noglob"]);

/** Drop what runs before the real command: assignments, keywords, and wrappers like timeout. */
function stripPrefixes(words) {
  let k = 0;
  const at = (n) => words[n] ?? "";
  while (k < words.length) {
    const w = words[k];
    if (ASSIGNMENT.test(w) || PREFIX_WORDS.has(w)) {
      k += 1;
    } else if (w === "nice") {
      k += 1;
      if (at(k) === "-n") k += 2;
      else if (/^(-\d+|--adjustment=.*)$/.test(at(k))) k += 1;
    } else if (w === "timeout") {
      k += 1;
      while (at(k).startsWith("-")) {
        const opt = at(k);
        k += ["-s", "-k", "--signal", "--kill-after"].includes(opt) ? 2 : 1;
      }
      k += 1; // the duration
    } else if (w === "stdbuf") {
      k += 1;
      while (at(k).startsWith("-")) k += /^-[ioe]$/.test(at(k)) ? 2 : 1;
    } else if (w === "env") {
      k += 1;
      while (at(k).startsWith("-") || ASSIGNMENT.test(at(k))) {
        k += ["-u", "--unset", "-C", "--chdir"].includes(at(k)) ? 2 : 1;
      }
    } else {
      break;
    }
  }
  return words.slice(k);
}

const base = (w) => w.slice(w.lastIndexOf("/") + 1);

/** Index of the first word at or after `from` that is not an option; `valued` options eat the next word. */
function skipOptions(words, from, valued = []) {
  let k = from;
  while (k < words.length && words[k].startsWith("-")) k += valued.includes(words[k]) ? 2 : 1;
  return k;
}

const SCRIPT = /^(test|coverage|attest|mutation|e2e)([:._-][\w:.-]*)?$/;
const INTERACTIVE_SCRIPT = /watch|dev|serve/;
const isHeavyScript = (name) => SCRIPT.test(name ?? "") && !INTERACTIVE_SCRIPT.test(name);

/** The heavy-command label of one simple command, or null. */
function heavyLabel(words) {
  if (words.length === 0) return null;
  const tool = base(words[0]);
  const rest = words.slice(1);

  if (tool === "npm") {
    const k = skipOptions(words, 1, ["-w", "--workspace", "--prefix"]);
    const sub = words[k];
    if (["test", "t", "tst"].includes(sub)) return "npm test";
    if (["run", "run-script"].includes(sub)) {
      const name = words[skipOptions(words, k + 1)];
      return isHeavyScript(name) ? `npm run ${name}` : null;
    }
    return null;
  }
  if (["pnpm", "yarn", "bun"].includes(tool)) {
    const k = skipOptions(words, 1, ["-C", "--dir", "--filter", "--cwd"]);
    const sub = words[k];
    if (sub === "test") return `${tool} test`;
    if (sub === "run") {
      const name = words[skipOptions(words, k + 1)];
      return isHeavyScript(name) ? `${tool} run ${name}` : null;
    }
    if (["exec", "dlx"].includes(sub)) return heavyLabel(words.slice(k + 1));
    return tool !== "bun" && isHeavyScript(sub) ? `${tool} ${sub}` : null;
  }
  if (["npx", "pnpx", "bunx"].includes(tool)) {
    return heavyLabel(words.slice(skipOptions(words, 1, ["-p", "--package"])));
  }
  if (tool === "vitest") {
    const quiet = ["watch", "dev", "bench", "init", "list", "--watch", "-w", "--ui"];
    return rest.some((w) => quiet.includes(w)) ? null : "vitest";
  }
  if (tool === "jest") return rest.some((w) => w === "--watch" || w === "--watchAll") ? null : "jest";
  if (tool === "bats") return "bats";
  if (tool === "playwright") return words[skipOptions(words, 1)] === "test" ? "playwright test" : null;
  if (tool === "stryker") return words[skipOptions(words, 1)] === "run" ? "stryker" : null;
  if (tool === "go") return words[skipOptions(words, 1, ["-C"])] === "test" ? "go test" : null;
  if (tool === "pytest" || tool === "py.test") return "pytest";
  if (/^python\d*(\.\d+)*$/.test(tool)) {
    const m = rest.indexOf("-m");
    return m >= 0 && rest[m + 1] === "pytest" ? "pytest" : null;
  }
  if (["uv", "poetry", "pipenv", "hatch"].includes(tool)) {
    const k = skipOptions(words, 1);
    if (words[k] !== "run") return null;
    return heavyLabel(words.slice(skipOptions(words, k + 1, ["--with", "--python", "-p", "--extra", "--group", "--package"])));
  }
  if (tool === "tox" || tool === "nox") return tool;
  if (tool === "make" || tool === "gmake") {
    for (let k = 1; k < words.length; k += 1) {
      const w = words[k];
      if (["-C", "-f", "--file", "--directory"].includes(w)) k += 1;
      else if (w === "-j" && /^\d+$/.test(words[k + 1] ?? "")) k += 1;
      else if (!w.startsWith("-") && !ASSIGNMENT.test(w) && /^(test|check)([-_:.].*)?$/.test(w)) return `make ${w}`;
    }
    return null;
  }
  if (tool === "cargo") {
    let k = 1;
    while (k < words.length && /^[+-]/.test(words[k])) k += 1;
    return ["test", "nextest"].includes(words[k]) ? "cargo test" : null;
  }
  if (tool === "mvn" || tool === "mvnw") {
    const goal = rest.find((w) => ["test", "verify", "integration-test"].includes(w));
    return goal ? `mvn ${goal}` : null;
  }
  if (tool === "gradle" || tool === "gradlew") {
    const task = rest.find((w) => /^(test|check|\w*Test)$/.test(w));
    return task ? `gradle ${task}` : null;
  }
  if (tool === "node") return rest.includes("--test") ? "node --test" : null;
  if (tool === "dotbabel" || tool === "dotbabel-local-attest" || tool === "dotbabel-quality") {
    const sub = tool === "dotbabel" ? rest : [tool.slice("dotbabel-".length), ...rest];
    if (sub[0] === "local-attest") return "dotbabel local-attest";
    if (sub[0] === "quality" && sub[1] === "check") return "dotbabel quality check";
  }
  return null;
}

/**
 * The label of the first heavy command in a shell command line — a test run
 * that uses many CPUs, such as `npm test`, `vitest`, `go test`, or `pytest` —
 * or null. It reads quotes and command separators, so `git commit -m
 * "npm test"` is not heavy, and it ignores watch modes, which never end.
 *
 * @param {string|null|undefined} command
 * @returns {string|null} a short label such as "npm test", safe to record (no arguments)
 */
export function findHeavyCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const segments = splitCommands(command);
  if (segments === null) return null;
  for (const words of segments) {
    const label = heavyLabel(stripPrefixes(words));
    if (label) return label;
  }
  return null;
}
