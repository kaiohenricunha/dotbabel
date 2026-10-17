/** Conservative literal shell parsing shared by the Advisor guard and trusted coordination hook. */
import { simpleCommands } from "../fleet/heavy.mjs";

/** Read one literal command without wrappers, expansion, or shell control. @param {string} command @returns {string[]|null} */
export function literalWords(command) {
  if (typeof command !== "string") return null;
  let quote = null;
  for (const c of command) {
    if (c === "\n" || c === "\r") return null;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (/[`$\\]/.test(c)) return null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (/[`$<>|&;(){}\\#*?~\[\]]/.test(c)) return null;
  }
  if (quote) return null;
  const commands = simpleCommands(command);
  if (!commands || commands.length !== 1) return null;
  const words = commands[0];
  const first = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s'"]+))/.exec(command);
  if (!first || (first[1] ?? first[2] ?? first[3]) !== words[0]) return null;
  return words;
}
