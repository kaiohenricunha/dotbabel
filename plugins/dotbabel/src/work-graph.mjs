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
 * A reference outside the clone is rated from what the bin hands in as a
 * {@link Resolution}: the tasks of each registered clone of a repository
 * (`clone-registry.mjs`, read offline), and the answers `gh` gave with
 * `--online`. Without them, such a reference is `unknown`.
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

/**
 * @typedef {"satisfied"|"open"|"missing"|"ambiguous"|"unknown"} DependencyState
 *
 * @typedef {object} DependencyStatus
 * @property {string} ref
 * @property {DependencyRef["kind"]} kind
 * @property {DependencyState} state  `satisfied` when the task is closed, the pull request
 *   is merged, or the issue is closed; `open` while it is not; `missing` when no worktree of
 *   the clone, or of any registered clone of the repository, holds the slug;
 *   `ambiguous` when two clones of one repository hold the slug (R-8);
 *   `unknown` when the repository is not registered on this machine, or a pull request or
 *   issue was not asked of `gh` or `gh` failed. Only `satisfied` lets a task go ahead;
 *   `ambiguous` and `unknown` count as blocked (KD-2).
 *
 * @typedef {object} RegisteredClone
 * @property {string} path   the clone's main checkout
 * @property {import("./task-state.mjs").Task[]} tasks  every task of every worktree of that clone
 *
 * @typedef {object} Resolution
 * @property {Map<string, RegisteredClone[]>} [clones]  the registered clones of each
 *   repository key a `clone-task` reference names
 * @property {Map<string, DependencyState>} [github]  the state `gh` reported for each
 *   `owner/repo#123` reference, with `--online`
 */

/**
 * The state of each reference `task` waits on, in the task's order.
 *
 * @param {import("./task-state.mjs").Task} task
 * @param {import("./task-state.mjs").Task[]} tasks  every task of the clone
 * @param {Resolution} [resolution]  what the bin resolved outside the clone
 * @returns {DependencyStatus[]}
 */
export function dependencyStates(task, tasks, resolution = {}) {
  const bySlug = new Map(tasks.map((other) => [other.slug, other]));
  return task.depends_on.map((ref) => {
    const parsed = /** @type {DependencyRef} */ (parseDependencyRef(ref));
    if (parsed.kind === "github") return { ref, kind: "github", state: resolution.github?.get(ref) ?? "unknown" };
    if (parsed.kind === "clone-task") return { ref, kind: "clone-task", state: cloneTaskState(parsed, resolution.clones) };
    return { ref, kind: "task", state: taskState(bySlug.get(parsed.slug)) };
  });
}

/** @param {import("./task-state.mjs").Task|undefined} target @returns {DependencyState} */
function taskState(target) {
  if (target === undefined) return "missing";
  return target.status === "closed" ? "satisfied" : "open";
}

/**
 * The state of a task of another clone: `unknown` until the repository is
 * registered; then `missing`, `ambiguous` when more than one clone holds the
 * slug, or the state of the one task that holds it.
 *
 * @param {{ repo: string, slug: string }} parsed
 * @param {Map<string, RegisteredClone[]>} [clones]
 * @returns {DependencyState}
 */
function cloneTaskState(parsed, clones) {
  const registered = clones?.get(parsed.repo);
  if (registered === undefined) return "unknown";
  const owners = registered.map((clone) => clone.tasks.find((task) => task.slug === parsed.slug)).filter((task) => task !== undefined);
  if (owners.length > 1) return "ambiguous";
  return taskState(owners[0]);
}

/**
 * The open tasks of the clone in dependency order: each task after the open
 * tasks it depends on, ties broken by slug, so the order is the same on every
 * read (KD-7). A closed or missing dependency constrains nothing. Tasks on a
 * cycle are left out of `order` and one cycle is reported.
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @returns {{ order: string[], cycle: string[]|null }}
 */
export function topologicalOrder(tasks) {
  const open = tasks.filter((task) => task.status === "open");
  const slugs = new Set(open.map((task) => task.slug));
  const remaining = new Map();
  const dependents = new Map();
  for (const task of open) {
    // A self reference stays in the set: it keeps the task off the order and in the cycle.
    const deps = new Set(cloneEdges([task]).map(([, to]) => to).filter((to) => slugs.has(to)));
    remaining.set(task.slug, deps);
    for (const to of deps) {
      if (!dependents.has(to)) dependents.set(to, []);
      dependents.get(to).push(task.slug);
    }
  }
  const order = [];
  let ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([slug]) => slug).sort();
  while (ready.length > 0) {
    const slug = /** @type {string} */ (ready.shift());
    order.push(slug);
    remaining.delete(slug);
    const freed = [];
    for (const dependent of dependents.get(slug) ?? []) {
      const deps = remaining.get(dependent);
      if (deps === undefined) continue;
      deps.delete(slug);
      if (deps.size === 0) freed.push(dependent);
    }
    if (freed.length > 0) ready = [...ready, ...freed].sort();
  }
  const cycle = remaining.size === 0 ? null : findCycle(open.filter((task) => remaining.has(task.slug)), [...remaining.keys()].sort()[0]);
  return { order, cycle };
}

/**
 * @typedef {object} WorkGraphNode
 * @property {string} slug
 * @property {string} worktree
 * @property {string} phase
 * @property {string[]} depends_on
 */

/**
 * The graph `dotbabel task graph` prints: every open task of the clone, the
 * same-clone edges between open tasks, the dependency order, and one cycle
 * when the files hold one.
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @returns {{ tasks: WorkGraphNode[], edges: [string, string][], order: string[], cycle: string[]|null }}
 */
export function buildWorkGraph(tasks) {
  const open = tasks.filter((task) => task.status === "open");
  const slugs = new Set(open.map((task) => task.slug));
  const { order, cycle } = topologicalOrder(open);
  return {
    tasks: open.map(({ slug, worktree, phase, depends_on }) => ({ slug, worktree, phase, depends_on: [...depends_on] })),
    edges: cloneEdges(open).filter(([, to]) => slugs.has(to)),
    order,
    cycle,
  };
}

/**
 * @typedef {object} ReadyTask
 * @property {string} slug
 * @property {string} worktree
 * @property {string} phase
 *
 * @typedef {ReadyTask & { waits_on: DependencyStatus[] }} BlockedTask
 */

/**
 * What `dotbabel task next` prints: the open tasks whose every dependency is
 * satisfied, then the ones that wait, each with the references it waits on.
 * Both lists follow the dependency order; a task on a cycle comes last, by
 * slug, and is never ready because its dependency is open.
 *
 * @param {import("./task-state.mjs").Task[]} tasks
 * @param {Resolution} [resolution]  what the bin resolved outside the clone
 * @returns {{ order: string[], ready: ReadyTask[], blocked: BlockedTask[] }}
 */
export function nextTasks(tasks, resolution = {}) {
  const open = tasks.filter((task) => task.status === "open");
  const { order } = topologicalOrder(open);
  const rank = new Map(order.map((slug, i) => [slug, i]));
  const sorted = [...open].sort((a, b) => (rank.get(a.slug) ?? Infinity) - (rank.get(b.slug) ?? Infinity) || a.slug.localeCompare(b.slug));
  const ready = [];
  const blocked = [];
  for (const task of sorted) {
    const waitsOn = dependencyStates(task, tasks, resolution);
    const node = { slug: task.slug, worktree: task.worktree, phase: task.phase };
    if (waitsOn.every((status) => status.state === "satisfied")) ready.push(node);
    else blocked.push({ ...node, waits_on: waitsOn });
  }
  return { order, ready, blocked };
}
