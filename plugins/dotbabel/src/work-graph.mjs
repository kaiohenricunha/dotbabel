/**
 * work-graph — the pure half of the work graph: the tasks of a clone as nodes,
 * their same-clone dependencies as edges, and the questions the task commands
 * ask of that graph.
 *
 * Nothing here runs git, reads the disk, calls the network (ARCH-3), or
 * imports another dotbabel module: `task-state.mjs` imports this one. The
 * worktree list arrives as the text `git worktree list --porcelain` prints,
 * and the tasks arrive as records; `task-state.mjs` does the reading. Each
 * read of the graph collects every worktree's task files again (KD-1): the
 * files stay the only source of truth.
 *
 * Only a bare `<slug>` reference is an edge of this graph. A task in another
 * clone (`github.com/owner/repo:<slug>`) and a pull request or issue
 * (`owner/repo#123`) cannot close a cycle inside the clone, so they are not
 * followed here. A reference to a slug that no worktree holds yet is allowed:
 * the task may be created later, and `task next` reports it meanwhile.
 *
 * The graph keeps its own sort and cycle search (KD-7): `pr-stack.mjs` sorts
 * pull request numbers, and this module sorts task references.
 */

const SLUG = "[a-z0-9][a-z0-9-]{0,63}";
const REPO_NAME = "[A-Za-z0-9_.-]+";
const TASK_REF_RE = new RegExp(`^${SLUG}$`);
const CLONE_TASK_RE = new RegExp(`^(github\\.com/${REPO_NAME}/${REPO_NAME}):(${SLUG})$`);
const GITHUB_REF_RE = new RegExp(`^(${REPO_NAME}/${REPO_NAME})#([1-9][0-9]*)$`);

/**
 * @typedef {{ kind: "task", slug: string }
 *   | { kind: "clone-task", repo: string, slug: string }
 *   | { kind: "github", repo: string, number: number }} DependencyRef
 */

/**
 * The parts of one `depends_on` entry, or null when it has none of the three
 * forms: a task of this clone (`<slug>`), a task of another clone on this
 * machine (`github.com/owner/repo:<slug>`), or a pull request or issue
 * (`owner/repo#123`). The slug grammar is the one `task-state.mjs` accepts
 * for a file name.
 *
 * @param {unknown} ref
 * @returns {DependencyRef|null}
 */
export function parseDependencyRef(ref) {
  if (typeof ref !== "string") return null;
  if (TASK_REF_RE.test(ref)) return { kind: "task", slug: ref };
  const clone = CLONE_TASK_RE.exec(ref);
  if (clone) return { kind: "clone-task", repo: clone[1], slug: clone[2] };
  const github = GITHUB_REF_RE.exec(ref);
  if (github) return { kind: "github", repo: github[1], number: Number(github[2]) };
  return null;
}

/**
 * The paths that `git worktree list --porcelain` names, in its order. A bare
 * repository entry is not a worktree and is skipped; any other line is
 * ignored.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseWorktreeList(text) {
  const roots = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    if (lines.some((line) => line === "bare")) continue;
    for (const line of lines) if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length));
  }
  return roots;
}

/**
 * The same-clone edges of `tasks`: one `[from, to]` pair for each bare slug in
 * a task's `depends_on`, in task order.
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @returns {[string, string][]}
 */
export function cloneEdges(tasks) {
  const edges = [];
  for (const task of tasks) {
    for (const ref of task.depends_on) {
      const parsed = parseDependencyRef(ref);
      if (parsed !== null && parsed.kind === "task") edges.push([task.slug, parsed.slug]);
    }
  }
  return edges;
}

/**
 * One cycle of the same-clone edges of `tasks` as the slugs along it, the
 * first repeated at the end, or null when the edges have none. The search
 * starts at `from` when given, so a refusal reports the edge being added
 * first; otherwise it starts at each task in turn.
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @param {string} [from]
 * @returns {string[]|null}
 */
export function findCycle(tasks, from) {
  const next = new Map();
  for (const [a, b] of cloneEdges(tasks)) {
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(b);
  }
  const done = new Set();
  const starts = from === undefined ? [...next.keys()] : [from];
  for (const start of starts) {
    const found = walk(start, [], new Set());
    if (found !== null) return found;
  }
  return null;

  /** @param {string} node @param {string[]} trail @param {Set<string>} onPath */
  function walk(node, trail, onPath) {
    if (onPath.has(node)) return [...trail.slice(trail.indexOf(node)), node];
    if (done.has(node)) return null;
    onPath.add(node);
    trail.push(node);
    for (const to of next.get(node) ?? []) {
      const found = walk(to, trail, onPath);
      if (found !== null) return found;
    }
    trail.pop();
    onPath.delete(node);
    done.add(node);
    return null;
  }
}

/**
 * The worktree that holds a task named `slug`, open or closed, or null when
 * no worktree of the clone does (KD-4).
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @param {string} slug
 * @returns {string|null}
 */
export function findSlugOwner(tasks, slug) {
  const owner = tasks.find((task) => task.slug === slug);
  return owner === undefined ? null : owner.worktree;
}
