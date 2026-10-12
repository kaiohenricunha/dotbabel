#!/usr/bin/env node
/**
 * dotbabel-task — the contract and durable state of work that has no spec.
 *
 * `new` fixes the goal and the `done_when` checks before execution starts.
 * `update` records the phase, decisions, and pending items as the work
 * proceeds. The SessionStart hook prints the open tasks of the worktree, so a
 * new or resumed session reads the state of the work instead of a retelling.
 * Storage and its limits are documented in src/task-state.mjs.
 *
 * Every git shell-out and all task storage go through src/task-state.mjs. The
 * bin itself reads only the hook payload on stdin. Usage: see USAGE below, or
 * `dotbabel task --help`.
 *
 * Exits:
 *   0   ok. `hook` always exits 0: it fails open, so a broken task file never blocks a session
 *   1   refused: the task exists, is not found, is closed, or names an item that is not pending
 *   2   environment error: not in a git repository, an unsafe path, a corrupt task file, a task
 *       another writer holds, or any filesystem error
 *   64  bad CLI invocation, including a blank text value
 */

import fs from "node:fs";
import { invokedDirectly, misfiredAs } from "../src/lib/invoked-direct.mjs";
import { parse } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import {
  TASK_ERROR_CODES,
  TaskError,
  closeTask,
  createTask,
  formatSessionContext,
  listTasks,
  mutateTask,
  readTask,
  resolveWorktree,
  updateTask,
  writeTask,
} from "../src/task-state.mjs";

const TOOL = "dotbabel-task";
const SUBCOMMANDS = new Set(["new", "update", "show", "list", "close", "hook"]);

const USAGE = `Usage:
  dotbabel task new    <slug> --goal <text> --done-when <text>... [--constraint <text>]... [--phase <p>]
  dotbabel task update <slug> [--phase <p>] [--decision <text>]... [--pending <text>]... [--done <text>]...
  dotbabel task show   <slug> [--json]
  dotbabel task list   [--all] [--json]
  dotbabel task close  <slug>
  dotbabel task hook   session-start            SessionStart hook entry (JSON on stdin)

A task is the contract (goal, done_when) and the state (phase, decisions,
pending) of work without a spec. It lives in <git-dir>/dotbabel/tasks/, one
per worktree, and never appears in git status.

Exit codes: 0 ok, 1 refused, 2 env error, 64 usage error.`;

const EXIT_BY_CODE = {
  [TASK_ERROR_CODES.TASK_SLUG_INVALID]: EXIT_CODES.USAGE,
  [TASK_ERROR_CODES.TASK_UPDATE_EMPTY]: EXIT_CODES.USAGE,
  [TASK_ERROR_CODES.TASK_EXISTS]: EXIT_CODES.VALIDATION,
  [TASK_ERROR_CODES.TASK_NOT_FOUND]: EXIT_CODES.VALIDATION,
  [TASK_ERROR_CODES.TASK_CLOSED]: EXIT_CODES.VALIDATION,
  [TASK_ERROR_CODES.TASK_PENDING_UNKNOWN]: EXIT_CODES.VALIDATION,
  // The bin refuses blank text values as usage errors before it builds a task,
  // so TASK_INVALID here means a corrupt file on disk: an environment problem.
  [TASK_ERROR_CODES.TASK_INVALID]: EXIT_CODES.ENV,
  [TASK_ERROR_CODES.TASK_LOCKED]: EXIT_CODES.ENV,
  [TASK_ERROR_CODES.TASK_PATH_UNSAFE]: EXIT_CODES.ENV,
  [TASK_ERROR_CODES.TASK_NO_REPO]: EXIT_CODES.ENV,
};

class UsageError extends Error {}

/**
 * The values of a repeatable text flag. A blank value is a usage error: it
 * would otherwise reach validation and be reported as a corrupt task (exit 2).
 */
function list(value, flag) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  for (const v of values) if (String(v).trim() === "") throw new UsageError(`--${flag} must not be blank`);
  return values;
}

/** One optional text flag, refused when blank. */
function text(value, flag) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(`--${flag} must not be blank`);
  return value;
}

function slugArg(args, sub) {
  const slug = args.positional[0];
  if (slug === undefined) throw new UsageError(`${sub} needs a task slug`);
  if (args.positional.length > 1) throw new UsageError(`${sub} takes one slug, got ${args.positional.length}`);
  return slug;
}

function render(task) {
  const lines = [
    `${task.slug} [${task.status}] phase: ${task.phase}`,
    `  goal: ${task.goal}`,
    "  done when:",
    ...task.done_when.map((d, i) => `    ${i + 1}. ${d}`),
  ];
  if (task.constraints.length > 0) lines.push("  constraints:", ...task.constraints.map((c) => `    - ${c}`));
  if (task.pending.length > 0) lines.push("  pending:", ...task.pending.map((p) => `    - ${p}`));
  if (task.decisions.length > 0) lines.push("  decisions:", ...task.decisions.map((d) => `    - ${d.at} ${d.text}`));
  lines.push(`  branch: ${task.branch ?? "(detached)"}  updated: ${task.updated_at}`);
  return lines.join("\n");
}

function emitTask(task, args, verb) {
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, task }, null, 2)}\n`);
  else process.stdout.write(`${verb ? `${verb}: ` : ""}${render(task)}\n`);
  return EXIT_CODES.OK;
}

function cmdNew(args) {
  const slug = slugArg(args, "new");
  const goal = text(args.flags.goal, "goal");
  const doneWhen = list(args.flags["done-when"], "done-when");
  if (goal === undefined) throw new UsageError("new needs --goal <text>");
  if (doneWhen.length === 0) throw new UsageError("new needs at least one --done-when <text>: define success before you start");
  const phase = text(args.flags.phase, "phase");
  const { root, branch } = resolveWorktree(process.cwd());
  const task = createTask({
    slug,
    goal,
    doneWhen,
    constraints: list(args.flags.constraint, "constraint"),
    ...(phase === undefined ? {} : { phase }),
    branch,
    worktree: root,
  });
  writeTask(root, task, { create: true });
  return emitTask(task, args, "created");
}

function cmdUpdate(args) {
  const slug = slugArg(args, "update");
  const phase = text(args.flags.phase, "phase");
  const change = {
    ...(phase === undefined ? {} : { phase }),
    decisions: list(args.flags.decision, "decision"),
    pending: list(args.flags.pending, "pending"),
    done: list(args.flags.done, "done"),
  };
  const task = mutateTask(resolveWorktree(process.cwd()).root, slug, (t) => updateTask(t, change));
  return emitTask(task, args, "updated");
}

function cmdShow(args) {
  return emitTask(readTask(resolveWorktree(process.cwd()).root, slugArg(args, "show")), args, "");
}

function cmdClose(args) {
  const slug = slugArg(args, "close");
  const task = mutateTask(resolveWorktree(process.cwd()).root, slug, (t) => closeTask(t));
  return emitTask(task, args, "closed");
}

function cmdList(args) {
  if (args.positional.length > 0) throw new UsageError("list takes no positional argument");
  const { tasks, problems } = listTasks(resolveWorktree(process.cwd()).root);
  const shown = tasks
    .filter((t) => args.flags.all === true || t.status === "open")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const p of problems) process.stderr.write(`${TOOL}: warning: ${p}\n`);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, tasks: shown, problems }, null, 2)}\n`);
    return EXIT_CODES.OK;
  }
  if (shown.length === 0) {
    process.stdout.write(args.flags.all === true ? "no tasks in this worktree\n" : "no open tasks in this worktree\n");
    return EXIT_CODES.OK;
  }
  for (const t of shown) process.stdout.write(`${t.slug} [${t.status}] phase: ${t.phase} — ${t.goal}\n`);
  return EXIT_CODES.OK;
}

/** SessionStart: the open tasks of the payload's worktree, as additionalContext. */
function runHook(event) {
  if (event !== "session-start") return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const context = formatSessionContext(listTasks(resolveWorktree(cwd).root).tasks);
  if (context === "") return;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`,
  );
}

function main(argv) {
  let args;
  try {
    args = parse(argv, {
      goal: { type: "string" },
      "done-when": { type: "string", multiple: true },
      constraint: { type: "string", multiple: true },
      phase: { type: "string" },
      decision: { type: "string", multiple: true },
      pending: { type: "string", multiple: true },
      done: { type: "string", multiple: true },
      all: { type: "boolean" },
    });
  } catch (err) {
    process.stderr.write(`${TOOL}: ${/** @type {Error} */ (err).message}\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  const [sub, ...rest] = args.positional;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_CODES.OK;
  }
  if (args.version) {
    process.stdout.write(`${version}\n`);
    return EXIT_CODES.OK;
  }
  if (!sub) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  if (!SUBCOMMANDS.has(sub)) {
    process.stderr.write(`${TOOL}: unknown subcommand "${sub}"\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  if (sub === "hook") {
    // A hook must never fail the session it informs: any error is silence.
    try {
      runHook(rest[0]);
    } catch (err) {
      if (process.env.DOTBABEL_DEBUG) process.stderr.write(`${TOOL}: ${/** @type {Error} */ (err).stack}\n`);
    }
    return EXIT_CODES.OK;
  }
  const subArgs = { ...args, positional: rest };
  try {
    if (sub === "new") return cmdNew(subArgs);
    if (sub === "update") return cmdUpdate(subArgs);
    if (sub === "show") return cmdShow(subArgs);
    if (sub === "close") return cmdClose(subArgs);
    return cmdList(subArgs);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${TOOL}: ${err.message}\n`);
      return EXIT_CODES.USAGE;
    }
    if (err instanceof TaskError) {
      process.stderr.write(`${TOOL}: ${err.message}\n`);
      return EXIT_BY_CODE[err.code] ?? EXIT_CODES.ENV;
    }
    // Anything else is a filesystem or runtime failure: an environment error,
    // never exit 1, which means "refused".
    process.stderr.write(`${TOOL}: ${/** @type {Error} */ (err).message}\n`);
    if (process.env.DOTBABEL_DEBUG) process.stderr.write(`${/** @type {Error} */ (err).stack}\n`);
    return EXIT_CODES.ENV;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
} else if (misfiredAs(TOOL)) {
  process.stderr.write(`${TOOL}: entry guard did not match argv[1]=${process.argv[1]}\n`);
  process.exitCode = EXIT_CODES.ENV;
}

export { main, USAGE };
