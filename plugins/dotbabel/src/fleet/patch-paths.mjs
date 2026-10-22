/**
 * The files a Codex `apply_patch` edit touches. The PreToolUse hook receives
 * the patch text in `tool_input.command`:
 *
 *   *** Begin Patch
 *   *** Update File: src/a.mjs          (also Add File, Delete File)
 *   *** Move to: src/b.mjs              (a rename's destination)
 *   ...
 *   *** End Patch
 *
 * Paths are as the patch writes them: relative to the session's cwd, or
 * absolute. Content lines start with "+", "-", " ", or "@@", so a header-like
 * line inside a file's content is never read as a header.
 */

const HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/;

/**
 * @param {unknown} text
 * @returns {string[]|null} each path once, in patch order; null when the text is not a patch
 */
export function patchPaths(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  if (start < 0) return null;
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const header = HEADER.exec(line);
    const file = header?.[1].trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  return paths;
}
