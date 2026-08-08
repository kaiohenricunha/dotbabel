/**
 * pr-stack — pure stacked-PR reasoning for the `pr-conductor` skill.
 *
 * Every export here is deterministic and free of I/O so the test suite can
 * exercise them without stubs. All `gh`/`git` shell-outs live in
 * `bin/dotbabel-pr-stack.mjs`; this module only ever *returns* command strings.
 *
 * A PR has exactly one `baseRefName`, so the child-to-parent relation is a
 * function and the resulting graph is a forest plus disjoint simple cycles.
 * A true diamond is therefore impossible — two PRs sharing a `headRefName` is
 * a data-integrity problem (`duplicate-head`), not a graph shape. That is why
 * cycle detection here is a parent-pointer walk rather than an SCC algorithm.
 *
 * @typedef {object} PrRecord
 * @property {number} number
 * @property {string} headRefName
 * @property {string} baseRefName
 * @property {string} [state] — OPEN | MERGED | CLOSED
 * @property {string} [mergeStateStatus] — CLEAN | BEHIND | DIRTY | BLOCKED | …
 * @property {string} [headRefOid]
 *
 * @typedef {object} StackNode
 * @property {number} number
 * @property {string} head
 * @property {string} base
 * @property {string} state
 * @property {string|null} mergeStateStatus
 * @property {string|null} headRefOid
 * @property {number|null} parent
 * @property {number[]} children
 * @property {number|null} depth — null when the node is unreachable from a root
 * @property {boolean} rootedOnTrunk
 * @property {boolean} orphan
 * @property {string|null} parentState
 * @property {boolean} inCycle
 *
 * @typedef {object} StackGraph
 * @property {string} trunk
 * @property {Record<string, StackNode>} nodes
 * @property {Record<string, number>} byHead
 * @property {number[]} roots
 * @property {{parent: number, child: number}[]} edges
 * @property {number[][]} cycles
 * @property {{head: string, numbers: number[]}[]} duplicateHeads
 * @property {{input: unknown, reason: string}[]} ignored
 *
 * @typedef {object} TopoResult
 * @property {boolean} ok
 * @property {number[]} order
 * @property {number[][]} cycles
 * @property {number[]} unordered
 *
 * @typedef {object} PlanEntry
 * @property {number} number
 * @property {string} head
 * @property {string} action
 * @property {string} reason
 * @property {number[]} blockedBy
 * @property {string|null} hint
 *
 * @typedef {object} StackProblem
 * @property {string} kind
 * @property {number[]} numbers
 * @property {string} message
 * @property {string|null} hint
 *
 * @typedef {object} StackPlan
 * @property {boolean} ok
 * @property {string} trunk
 * @property {number[]} order
 * @property {PlanEntry[]} actionable
 * @property {PlanEntry[]} pending
 * @property {StackProblem[]} problems
 * @property {{total: number, actionable: number, pending: number, problems: number}} counts
 *
 * @typedef {object} TransitionStep
 * @property {string} id
 * @property {string} cmd
 *
 * @typedef {object} ChildTransition
 * @property {number} number
 * @property {string} action
 * @property {boolean} needsRetarget
 * @property {string} oldBase
 * @property {string} newBase
 * @property {boolean} needsRebase
 * @property {"onto"|"plain"|null} rebaseKind
 * @property {string} reason
 * @property {TransitionStep[]} steps
 * @property {boolean} confirmationRequired
 * @property {string[]} warnings
 */

/** What the conductor should do with a PR next. */
export const STACK_ACTION = Object.freeze({
  LAND: "land",
  WAIT: "wait",
  RETARGET: "retarget",
  REBASE: "rebase",
  RESOLVE: "resolve",
});

/** Structural defects that require a human decision. */
export const STACK_PROBLEM = Object.freeze({
  CYCLE: "cycle",
  ORPHAN_BASE: "orphan-base",
  PARENT_CLOSED_UNMERGED: "parent-closed-unmerged",
  DUPLICATE_HEAD: "duplicate-head",
});

const DEFAULT_TRUNK = "main";
const DEFAULT_REMOTE = "origin";

/** Git refs we are willing to interpolate into a command string. */
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Statuses that mean the branch must be replayed on a moved base. */
const STALE_STATUSES = new Set(["BEHIND", "DIRTY"]);

const ASC = (a, b) => a - b;

/**
 * Throw unless `name` is a git ref safe to embed in a shell command. Guards
 * every branch name that reaches an emitted `cmd` string — PR head refs are
 * attacker-influenced input.
 *
 * @param {unknown} name
 * @param {string} label
 * @returns {string}
 */
function assertBranch(name, label) {
  if (typeof name !== "string" || !BRANCH_RE.test(name)) {
    throw new Error(`invalid branch name for ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Normalize one raw `gh` record, or explain why it is unusable.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: PrRecord} | {ok: false, reason: string}}
 */
function normalize(raw) {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (typeof rec.number !== "number" || !Number.isFinite(rec.number)) {
    return { ok: false, reason: "missing numeric number" };
  }
  if (typeof rec.headRefName !== "string" || rec.headRefName === "") {
    return { ok: false, reason: "missing headRefName" };
  }
  if (typeof rec.baseRefName !== "string" || rec.baseRefName === "") {
    return { ok: false, reason: "missing baseRefName" };
  }
  return {
    ok: true,
    value: /** @type {PrRecord} */ ({
      number: rec.number,
      headRefName: rec.headRefName,
      baseRefName: rec.baseRefName,
      state: typeof rec.state === "string" ? rec.state : "OPEN",
      mergeStateStatus: typeof rec.mergeStateStatus === "string" ? rec.mergeStateStatus : null,
      headRefOid: typeof rec.headRefOid === "string" ? rec.headRefOid : null,
    }),
  };
}

/**
 * Find every simple cycle by walking parent pointers. Safe because the graph
 * is functional: each node has at most one parent, so a path can rejoin itself
 * only at its own start. Each cycle is rotated to begin at its lowest number.
 *
 * @param {Record<string, StackNode>} nodes
 * @returns {number[][]}
 */
function findCycles(nodes) {
  /** @type {Map<number, string>} */
  const state = new Map();
  /** @type {number[][]} */
  const cycles = [];

  for (const key of Object.keys(nodes)) {
    const start = nodes[key].number;
    if (state.has(start)) continue;

    /** @type {number[]} */
    const path = [];
    /** @type {Map<number, number>} */
    const seenAt = new Map();
    let cur = /** @type {number|null} */ (start);

    while (cur !== null && !state.has(cur)) {
      seenAt.set(cur, path.length);
      path.push(cur);
      state.set(cur, "visiting");
      cur = nodes[String(cur)].parent;
    }

    if (cur !== null && state.get(cur) === "visiting" && seenAt.has(cur)) {
      const cycle = path.slice(/** @type {number} */ (seenAt.get(cur)));
      const pivot = cycle.indexOf(Math.min(...cycle));
      cycles.push([...cycle.slice(pivot), ...cycle.slice(0, pivot)]);
    }
    for (const n of path) state.set(n, "done");
  }

  return cycles.sort((a, b) => a[0] - b[0]);
}

/**
 * Build the dependency graph for a set of PRs. Malformed records are collected
 * into `ignored` rather than throwing, so one bad row cannot blind the caller
 * to the rest of the stack.
 *
 * @param {unknown} prs — raw `gh pr list --json …` output
 * @param {{trunk?: string}} [opts]
 * @returns {StackGraph}
 */
export function buildStackGraph(prs, opts = {}) {
  const trunk = opts.trunk ?? DEFAULT_TRUNK;
  /** @type {{input: unknown, reason: string}[]} */
  const ignored = [];
  /** @type {PrRecord[]} */
  const records = [];

  for (const raw of Array.isArray(prs) ? prs : []) {
    const result = normalize(raw);
    if (result.ok) records.push(result.value);
    else ignored.push({ input: raw, reason: result.reason });
  }
  records.sort((a, b) => ASC(a.number, b.number));

  /** @type {Record<string, number>} */
  const byHead = {};
  /** @type {Map<string, number[]>} */
  const headOwners = new Map();
  /** @type {Map<string, boolean>} */
  const boundToOpen = new Map();
  for (const rec of records) {
    const owners = headOwners.get(rec.headRefName) ?? [];
    owners.push(rec.number);
    headOwners.set(rec.headRefName, owners);

    // Bind to the lowest-numbered OPEN PR when one exists. A bot that reuses a
    // branch across releases leaves several merged PRs on the same head; a
    // child must resolve its parent to the live one, not the first ever.
    const isOpen = rec.state === "OPEN";
    if (!(rec.headRefName in byHead) || (isOpen && boundToOpen.get(rec.headRefName) !== true)) {
      byHead[rec.headRefName] = rec.number;
      boundToOpen.set(rec.headRefName, isOpen);
    }
  }

  const duplicateHeads = [...headOwners.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([head, numbers]) => ({ head, numbers: [...numbers].sort(ASC) }))
    .sort((a, b) => a.head.localeCompare(b.head));

  /** @type {Record<string, StackNode>} */
  const nodes = {};
  for (const rec of records) {
    const rootedOnTrunk = rec.baseRefName === trunk;
    const parentNumber = rootedOnTrunk ? null : (byHead[rec.baseRefName] ?? null);
    nodes[String(rec.number)] = {
      number: rec.number,
      head: rec.headRefName,
      base: rec.baseRefName,
      state: rec.state ?? "OPEN",
      mergeStateStatus: rec.mergeStateStatus ?? null,
      headRefOid: rec.headRefOid ?? null,
      parent: parentNumber === rec.number ? null : parentNumber,
      children: [],
      depth: null,
      rootedOnTrunk,
      orphan: !rootedOnTrunk && parentNumber === null,
      parentState: null,
      inCycle: false,
    };
  }

  /** @type {{parent: number, child: number}[]} */
  const edges = [];
  for (const key of Object.keys(nodes)) {
    const node = nodes[key];
    if (node.parent === null) continue;
    nodes[String(node.parent)].children.push(node.number);
    node.parentState = nodes[String(node.parent)].state;
    edges.push({ parent: node.parent, child: node.number });
  }
  for (const key of Object.keys(nodes)) nodes[key].children.sort(ASC);
  edges.sort((a, b) => ASC(a.child, b.child));

  const cycles = findCycles(nodes);
  for (const cycle of cycles) {
    for (const n of cycle) nodes[String(n)].inCycle = true;
  }

  const roots = Object.keys(nodes)
    .map((k) => nodes[k])
    .filter((n) => n.parent === null)
    .map((n) => n.number)
    .sort(ASC);

  const queue = [...roots];
  for (const r of roots) nodes[String(r)].depth = 0;
  while (queue.length > 0) {
    const current = nodes[String(/** @type {number} */ (queue.shift()))];
    for (const child of current.children) {
      nodes[String(child)].depth = /** @type {number} */ (current.depth) + 1;
      queue.push(child);
    }
  }

  return { trunk, nodes, byHead, roots, edges, cycles, duplicateHeads, ignored };
}

/**
 * Topologically order the graph, parents before children. Ties are broken by
 * ascending PR number so the output is stable across runs.
 *
 * @param {StackGraph} graph
 * @returns {TopoResult}
 */
export function topoOrder(graph) {
  const { nodes } = graph;
  /** @type {number[]} */
  const order = [];
  const available = [...graph.roots];

  while (available.length > 0) {
    available.sort(ASC);
    const next = /** @type {number} */ (available.shift());
    order.push(next);
    available.push(...nodes[String(next)].children);
  }

  const placed = new Set(order);
  const unordered = Object.keys(nodes)
    .map((k) => nodes[k].number)
    .filter((n) => !placed.has(n))
    .sort(ASC);

  return { ok: unordered.length === 0, order, cycles: graph.cycles, unordered };
}

/**
 * Classify one node into the action the conductor should take next.
 *
 * @param {StackNode} node
 * @returns {{action: string, reason: string, blockedBy: number[], hint: string|null, problem: string|null}}
 */
function classify(node) {
  if (node.inCycle) {
    return {
      action: STACK_ACTION.RESOLVE,
      reason: "part of a base-branch cycle",
      blockedBy: [],
      hint: "retarget one PR in the cycle onto the trunk",
      problem: STACK_PROBLEM.CYCLE,
    };
  }
  if (node.orphan) {
    return {
      action: STACK_ACTION.RESOLVE,
      reason: `base ${node.base} is neither the trunk nor an open PR head`,
      blockedBy: [],
      hint: `retarget #${node.number} onto the trunk`,
      problem: STACK_PROBLEM.ORPHAN_BASE,
    };
  }
  if (node.parentState === "CLOSED") {
    return {
      action: STACK_ACTION.RETARGET,
      reason: `parent #${node.parent} was closed without merging`,
      blockedBy: [],
      hint: "its commits remain in this branch — confirm the diff before landing",
      problem: STACK_PROBLEM.PARENT_CLOSED_UNMERGED,
    };
  }
  if (node.parentState === "MERGED") {
    return {
      action: STACK_ACTION.RETARGET,
      reason: `parent #${node.parent} merged; base must move`,
      blockedBy: [],
      hint: `run: dotbabel pr-stack next --pr ${node.number} --parent ${node.parent}`,
      problem: null,
    };
  }
  if (node.parent !== null) {
    return {
      action: STACK_ACTION.WAIT,
      reason: `parent #${node.parent} is ${node.parentState ?? "OPEN"}`,
      blockedBy: [/** @type {number} */ (node.parent)],
      hint: `land #${node.parent} first`,
      problem: null,
    };
  }
  if (node.mergeStateStatus !== null && STALE_STATUSES.has(node.mergeStateStatus)) {
    return {
      action: STACK_ACTION.REBASE,
      reason: `branch is ${node.mergeStateStatus} relative to its base`,
      blockedBy: [],
      hint: "rebase onto the trunk before landing",
      problem: null,
    };
  }
  return {
    action: STACK_ACTION.LAND,
    reason: "based on the trunk with no unmerged parent",
    blockedBy: [],
    hint: null,
    problem: null,
  };
}

/**
 * Turn a graph into an actionable plan: what can move now, what is blocked,
 * and what needs a human. Only OPEN PRs are scheduled; merged and closed ones
 * are retained in the graph purely as context for their children.
 *
 * @param {StackGraph} graph
 * @returns {StackPlan}
 */
export function planStack(graph) {
  const { order } = topoOrder(graph);
  const scheduled = [...order, ...Object.keys(graph.nodes).map((k) => graph.nodes[k].number)].filter(
    (n, i, arr) => arr.indexOf(n) === i,
  );

  /** @type {PlanEntry[]} */
  const actionable = [];
  /** @type {PlanEntry[]} */
  const pending = [];
  /** @type {StackProblem[]} */
  const problems = [];

  for (const cycle of graph.cycles) {
    problems.push({
      kind: STACK_PROBLEM.CYCLE,
      numbers: cycle,
      message: `PRs ${cycle.map((n) => `#${n}`).join(" → ")} form a base-branch cycle`,
      hint: "retarget one of them onto the trunk",
    });
  }
  for (const dup of graph.duplicateHeads) {
    // Only ambiguous when more than one is still open — a reused release
    // branch whose earlier PRs are all merged is routine, not a defect.
    const open = dup.numbers.filter((n) => graph.nodes[String(n)].state === "OPEN");
    if (open.length < 2) continue;
    problems.push({
      kind: STACK_PROBLEM.DUPLICATE_HEAD,
      numbers: open,
      message: `PRs ${open.map((n) => `#${n}`).join(", ")} share head branch ${dup.head}`,
      hint: "close the stale duplicate before landing either",
    });
  }

  for (const number of scheduled) {
    const node = graph.nodes[String(number)];
    if (node.state !== "OPEN") continue;
    const verdict = classify(node);
    const entry = {
      number: node.number,
      head: node.head,
      action: verdict.action,
      reason: verdict.reason,
      blockedBy: verdict.blockedBy,
      hint: verdict.hint,
    };

    if (verdict.problem !== null && verdict.problem !== STACK_PROBLEM.CYCLE) {
      problems.push({
        kind: verdict.problem,
        numbers: [node.number],
        message: `#${node.number}: ${verdict.reason}`,
        hint: verdict.hint,
      });
    }

    if (verdict.action === STACK_ACTION.WAIT) pending.push(entry);
    else if (verdict.action !== STACK_ACTION.RESOLVE) actionable.push(entry);
  }

  return {
    ok: problems.length === 0,
    trunk: graph.trunk,
    order,
    actionable,
    pending,
    problems,
    counts: {
      total: Object.keys(graph.nodes).length,
      actionable: actionable.length,
      pending: pending.length,
      problems: problems.length,
    },
  };
}

/**
 * Decide what a child PR must do once its parent has left the OPEN state.
 *
 * The repo squash-merges (`gh pr merge --squash`), so the parent's original
 * commits are NOT ancestors of the squashed commit on the trunk. A plain
 * `git rebase <trunk>` would replay them and conflict on every shared file;
 * the correct move is `git rebase --onto <newBase> <parent-head> <child-head>`,
 * which drops the parent's commits outright. Returns command strings only —
 * this function never executes anything.
 *
 * @param {{child: PrRecord, parent: PrRecord, trunk?: string, remote?: string}} input
 * @returns {ChildTransition}
 */
export function planChildTransition(input) {
  const { child, parent } = input;
  const trunk = input.trunk ?? DEFAULT_TRUNK;
  const remote = input.remote ?? DEFAULT_REMOTE;

  const childHead = assertBranch(child.headRefName, "child head");
  const parentHead = assertBranch(parent.headRefName, "parent head");
  const oldBase = assertBranch(child.baseRefName, "child base");
  const newBase = assertBranch(parent.baseRefName ?? trunk, "new base");
  assertBranch(remote, "remote");

  /** @type {string[]} */
  const warnings = [];
  /** @type {TransitionStep[]} */
  const steps = [];

  if (parent.state === "OPEN") {
    return {
      number: child.number,
      action: STACK_ACTION.WAIT,
      needsRetarget: false,
      oldBase,
      newBase,
      needsRebase: false,
      rebaseKind: null,
      reason: `parent #${parent.number} is not merged`,
      steps,
      confirmationRequired: false,
      warnings,
    };
  }

  const needsRetarget = oldBase !== newBase;
  if (needsRetarget) {
    steps.push({ id: "retarget", cmd: `gh pr edit ${child.number} --base ${newBase}` });
  }

  if (parent.state === "CLOSED") {
    warnings.push(
      `parent #${parent.number} was closed without merging — its commits remain in ${childHead}'s history ` +
        `and will now appear in this PR's diff; confirm that is intended`,
    );
    return {
      number: child.number,
      action: STACK_ACTION.RETARGET,
      needsRetarget,
      oldBase,
      newBase,
      needsRebase: false,
      rebaseKind: null,
      reason: `parent #${parent.number} closed unmerged; retarget only`,
      steps,
      confirmationRequired: false,
      warnings,
    };
  }

  const stale = child.mergeStateStatus !== undefined && STALE_STATUSES.has(String(child.mergeStateStatus));
  if (!needsRetarget && !stale) {
    return {
      number: child.number,
      action: STACK_ACTION.LAND,
      needsRetarget: false,
      oldBase,
      newBase,
      needsRebase: false,
      rebaseKind: null,
      reason: "already rebased onto the new base",
      steps,
      confirmationRequired: false,
      warnings,
    };
  }

  const rebaseKind = needsRetarget ? "onto" : "plain";
  let cutoff = parentHead;
  if (rebaseKind === "onto") {
    if (typeof parent.headRefOid === "string" && parent.headRefOid !== "") {
      cutoff = parent.headRefOid;
    } else {
      warnings.push(
        `parent branch ${parentHead} may already be deleted by --delete-branch; ` +
          `pass --parent-sha for a deterministic rebase`,
      );
    }
  }

  steps.push({ id: "fetch", cmd: `git fetch ${remote} ${newBase}` });
  steps.push({ id: "checkout", cmd: `git checkout ${childHead}` });
  steps.push({
    id: "rebase",
    cmd:
      rebaseKind === "onto"
        ? `git rebase --onto ${remote}/${newBase} ${cutoff} ${childHead}`
        : `git rebase ${remote}/${newBase}`,
  });
  steps.push({ id: "push", cmd: `git push --force-with-lease ${remote} ${childHead}` });

  return {
    number: child.number,
    action: needsRetarget ? STACK_ACTION.RETARGET : STACK_ACTION.REBASE,
    needsRetarget,
    oldBase,
    newBase,
    needsRebase: true,
    rebaseKind,
    reason: needsRetarget
      ? `parent #${parent.number} squash-merged; drop its commits and retarget to ${newBase}`
      : `branch is ${child.mergeStateStatus} relative to ${newBase}`,
    steps,
    confirmationRequired: steps.some((s) => s.cmd.includes("--force-with-lease")),
    warnings,
  };
}
