/**
 * task-state — the contract and the durable state of one piece of work that
 * has no spec.
 *
 * A spec gives a change executable acceptance criteria. Most work is smaller
 * than a spec, and without one nothing records what "done" means or where the
 * work stands, so a context reset, a crash, or a new session starts from a
 * retelling. A task is that record: a goal and a non-empty `done_when` list,
 * fixed before execution, plus the phase, the decisions, and the pending items
 * the session writes as it works.
 *
 * Storage is `<git-dir>/dotbabel/tasks/<slug>.json`, for the same reason
 * `attest-run.mjs` keeps its manifest there: a file under the git directory
 * never appears in `git status`, whatever a repository ignores, so it cannot
 * trip a clean-tree check. `--absolute-git-dir` names a linked worktree's own
 * directory, so each worktree has its own tasks. The state survives context
 * resets, crashes, and new sessions in that worktree. It does not travel to
 * another machine and it goes away with the worktree; `/handoff` covers that.
 *
 * The pure half (create, update, close, validate, format) does no I/O. The
 * storage half follows `criteria/spec-file.mjs`: no symbolic link on the path,
 * and the resolved path must stay inside the git directory.
 *
 * @typedef {object} TaskDecision
 * @property {string} at    ISO timestamp.
 * @property {string} text
 *
 * @typedef {object} Task
 * @property {1} schema_version
 * @property {string} slug
 * @property {"open"|"closed"} status
 * @property {string} goal
 * @property {string[]} done_when
 * @property {string[]} constraints
 * @property {string} phase
 * @property {TaskDecision[]} decisions
 * @property {string[]} pending
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string|null} closed_at
 * @property {string|null} branch
 * @property {string} worktree
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The `schema_version` this module writes and reads. */
export const TASK_SCHEMA_VERSION = 1;

/** The tasks directory, relative to the worktree's git directory. */
export const TASK_STATE_DIR = path.join("dotbabel", "tasks");

/** Stable error codes. The CLI maps each to an exit code. */
export const TASK_ERROR_CODES = Object.freeze({
  TASK_SLUG_INVALID: "TASK_SLUG_INVALID",
  TASK_INVALID: "TASK_INVALID",
  TASK_UPDATE_EMPTY: "TASK_UPDATE_EMPTY",
  TASK_EXISTS: "TASK_EXISTS",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_CLOSED: "TASK_CLOSED",
  TASK_PENDING_UNKNOWN: "TASK_PENDING_UNKNOWN",
  TASK_PATH_UNSAFE: "TASK_PATH_UNSAFE",
  TASK_NO_REPO: "TASK_NO_REPO",
});

/** An error with a stable `code` from `TASK_ERROR_CODES`. */
export class TaskError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TaskError";
    this.code = code;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const KEYS = Object.freeze([
  "schema_version",
  "slug",
  "status",
  "goal",
  "done_when",
  "constraints",
  "phase",
  "decisions",
  "pending",
  "created_at",
  "updated_at",
  "closed_at",
  "branch",
  "worktree",
]);

/**
 * True for a slug that can name a file in the tasks directory and nothing else:
 * lowercase letters, digits, and dashes, 1 to 64 characters, not starting with
 * a dash.
 *
 * @param {unknown} slug
 * @returns {boolean}
 */
export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isTime = (v) => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Every way `value` fails to be a task this version reads. Empty means valid.
 * Mirrors `schemas/dotbabel.task-state.schema.json`; a test holds the two
 * together.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function validateTask(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["a task must be a JSON object"];
  const t = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  for (const key of Object.keys(t)) if (!KEYS.includes(key)) problems.push(`unknown key "${key}"`);
  for (const key of KEYS) if (!(key in t)) problems.push(`missing "${key}"`);
  if (t.schema_version !== TASK_SCHEMA_VERSION) problems.push(`schema_version must be ${TASK_SCHEMA_VERSION}`);
  if (!isValidSlug(t.slug)) problems.push("slug must be lowercase letters, digits, and dashes");
  if (t.status !== "open" && t.status !== "closed") problems.push('status must be "open" or "closed"');
  if (!isText(t.goal)) problems.push("goal must be a non-empty string");
  if (!isTextList(t.done_when) || /** @type {unknown[]} */ (t.done_when).length === 0) {
    problems.push("done_when must be a non-empty list of non-empty strings");
  }
  if (!isTextList(t.constraints)) problems.push("constraints must be a list of non-empty strings");
  if (!isText(t.phase)) problems.push("phase must be a non-empty string");
  if (
    !Array.isArray(t.decisions) ||
    !t.decisions.every(
      (d) =>
        d !== null &&
        typeof d === "object" &&
        Object.keys(d).length === 2 &&
        isTime(d.at) &&
        isText(d.text),
    )
  ) {
    problems.push("decisions must be a list of {at, text}");
  }
  if (!isTextList(t.pending)) problems.push("pending must be a list of non-empty strings");
  if (!isTime(t.created_at)) problems.push("created_at must be an ISO timestamp");
  if (!isTime(t.updated_at)) problems.push("updated_at must be an ISO timestamp");
  if (t.closed_at !== null && !isTime(t.closed_at)) problems.push("closed_at must be null or an ISO timestamp");
  if (t.branch !== null && !isText(t.branch)) problems.push("branch must be null or a non-empty string");
  if (!isText(t.worktree)) problems.push("worktree must be a non-empty string");
  return problems;
}

function assertValid(task) {
  const problems = validateTask(task);
  if (problems.length > 0) throw new TaskError(TASK_ERROR_CODES.TASK_INVALID, problems.join("; "));
  return task;
}

function assertSlug(slug) {
  if (!isValidSlug(slug)) {
    throw new TaskError(
      TASK_ERROR_CODES.TASK_SLUG_INVALID,
      `"${String(slug)}" is not a task slug (lowercase letters, digits, and dashes, up to 64)`,
    );
  }
}

/**
 * A new open task. The contract is the goal and `done_when`: success is
 * defined before execution starts, so a task without a `done_when` item is
 * refused.
 *
 * @param {{ slug: string, goal: string, doneWhen: string[], constraints?: string[], phase?: string,
 *   branch?: string|null, worktree: string, now?: Date }} input
 * @returns {Task}
 */
export function createTask({ slug, goal, doneWhen, constraints = [], phase = "started", branch = null, worktree, now }) {
  assertSlug(slug);
  const at = (now ?? new Date()).toISOString();
  return assertValid({
    schema_version: TASK_SCHEMA_VERSION,
    slug,
    status: "open",
    goal,
    done_when: [...doneWhen],
    constraints: [...constraints],
    phase,
    decisions: [],
    pending: [],
    created_at: at,
    updated_at: at,
    closed_at: null,
    branch,
    worktree,
  });
}

/**
 * A copy of `task` with a new phase, appended decisions and pending items, and
 * finished pending items removed. The input is never changed.
 *
 * @param {Task} task
 * @param {{ phase?: string, decisions?: string[], pending?: string[], done?: string[], now?: Date }} change
 * @returns {Task}
 */
export function updateTask(task, { phase, decisions = [], pending = [], done = [], now } = {}) {
  if (task.status === "closed") throw new TaskError(TASK_ERROR_CODES.TASK_CLOSED, `task "${task.slug}" is closed`);
  if (phase === undefined && decisions.length === 0 && pending.length === 0 && done.length === 0) {
    throw new TaskError(TASK_ERROR_CODES.TASK_UPDATE_EMPTY, "give --phase, --decision, --pending, or --done");
  }
  const at = (now ?? new Date()).toISOString();
  const remaining = [...task.pending, ...pending];
  for (const item of done) {
    const i = remaining.indexOf(item);
    if (i === -1) throw new TaskError(TASK_ERROR_CODES.TASK_PENDING_UNKNOWN, `"${item}" is not a pending item of "${task.slug}"`);
    remaining.splice(i, 1);
  }
  return assertValid({
    ...task,
    phase: phase ?? task.phase,
    decisions: [...task.decisions, ...decisions.map((text) => ({ at, text }))],
    pending: remaining,
    updated_at: at,
  });
}

/**
 * A copy of `task` marked closed. The record stays, so the decisions it holds
 * can still be read with `show`.
 *
 * @param {Task} task
 * @param {{ now?: Date }} [opts]
 * @returns {Task}
 */
export function closeTask(task, { now } = {}) {
  if (task.status === "closed") throw new TaskError(TASK_ERROR_CODES.TASK_CLOSED, `task "${task.slug}" is already closed`);
  const at = (now ?? new Date()).toISOString();
  return assertValid({ ...task, status: "closed", closed_at: at, updated_at: at });
}

const MAX_TASKS = 5;
const MAX_DECISIONS = 3;
const MAX_PENDING = 10;
const MAX_FIELD = 300;

function clip(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_FIELD ? `${flat.slice(0, MAX_FIELD - 1)}…` : flat;
}

/**
 * The SessionStart context for the open tasks: the most recently updated first,
 * at most five, each field clipped, so the text stays small. Empty when no task
 * is open.
 *
 * @param {Task[]} tasks
 * @returns {string}
 */
export function formatSessionContext(tasks) {
  const open = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (open.length === 0) return "";
  const lines = ["Open dotbabel tasks in this worktree. Read the task before you continue its work:"];
  for (const t of open.slice(0, MAX_TASKS)) {
    lines.push(`- ${t.slug} (phase: ${clip(t.phase)}, updated ${t.updated_at}) — \`dotbabel task show ${t.slug}\``);
    lines.push(`  goal: ${clip(t.goal)}`);
    lines.push(`  done when: ${t.done_when.map((d, i) => `(${i + 1}) ${clip(d)}`).join(" ")}`);
    if (t.pending.length > 0) {
      const shown = t.pending.slice(0, MAX_PENDING).map(clip);
      const more = t.pending.length - shown.length;
      lines.push(`  pending: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
    }
    for (const d of t.decisions.slice(-MAX_DECISIONS)) lines.push(`  decision (${d.at}): ${clip(d.text)}`);
  }
  if (open.length > MAX_TASKS) lines.push(`(${open.length - MAX_TASKS} more open task(s): \`dotbabel task list\`)`);
  return lines.join("\n");
}

// ------------------------------------------------------------- storage ----

/** Git with the caller's GIT_* variables removed, so `-C` decides the repo. */
function gitDir(worktreeRoot) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync("git", ["-C", worktreeRoot, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", env });
  const dir = r.status === 0 ? r.stdout.trim() : "";
  if (dir === "") throw new TaskError(TASK_ERROR_CODES.TASK_NO_REPO, `${worktreeRoot} is not inside a git repository`);
  return dir;
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function unsafe(p) {
  return new TaskError(TASK_ERROR_CODES.TASK_PATH_UNSAFE, `${p} is a symbolic link or resolves outside the git directory`);
}

/**
 * The absolute tasks directory of the worktree that contains `worktreeRoot`.
 * Refuses a symbolic link at any level below the git directory. Does not
 * create the directory.
 *
 * @param {string} worktreeRoot
 * @returns {string}
 */
export function tasksDir(worktreeRoot) {
  const base = gitDir(worktreeRoot);
  const realBase = fs.realpathSync(base);
  let current = base;
  for (const part of TASK_STATE_DIR.split(path.sep)) {
    current = path.join(current, part);
    if (isSymlink(current)) throw unsafe(current);
  }
  if (fs.existsSync(current) && !fs.realpathSync(current).startsWith(`${realBase}${path.sep}`)) throw unsafe(current);
  return current;
}

function taskFile(worktreeRoot, slug) {
  assertSlug(slug);
  const file = path.join(tasksDir(worktreeRoot), `${slug}.json`);
  if (isSymlink(file)) throw unsafe(file);
  return file;
}

function parseTaskFile(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new TaskError(TASK_ERROR_CODES.TASK_INVALID, `${label} does not parse: ${/** @type {Error} */ (err).message}`);
  }
  const problems = validateTask(value);
  if (problems.length > 0) throw new TaskError(TASK_ERROR_CODES.TASK_INVALID, `${label}: ${problems.join("; ")}`);
  return /** @type {Task} */ (value);
}

/**
 * Read one task.
 *
 * @param {string} worktreeRoot
 * @param {string} slug
 * @returns {Task}
 */
export function readTask(worktreeRoot, slug) {
  const file = taskFile(worktreeRoot, slug);
  if (!fs.existsSync(file)) throw new TaskError(TASK_ERROR_CODES.TASK_NOT_FOUND, `no task "${slug}" in this worktree`);
  return parseTaskFile(file, `task "${slug}"`);
}

/**
 * Write one task atomically (temp file, then rename). With `create`, refuse a
 * slug that already has a file, open or closed.
 *
 * @param {string} worktreeRoot
 * @param {Task} task
 * @param {{ create?: boolean }} [opts]
 * @returns {string} the file written
 */
export function writeTask(worktreeRoot, task, { create = false } = {}) {
  assertValid(task);
  const file = taskFile(worktreeRoot, task.slug);
  if (create && fs.existsSync(file)) throw new TaskError(TASK_ERROR_CODES.TASK_EXISTS, `task "${task.slug}" already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Every task file in the worktree, open and closed. A file that does not parse
 * or validate is reported in `problems` rather than failing the whole list.
 * Symbolic links and non-JSON files are skipped.
 *
 * @param {string} worktreeRoot
 * @returns {{ tasks: Task[], problems: string[] }}
 */
export function listTasks(worktreeRoot) {
  const dir = tasksDir(worktreeRoot);
  if (!fs.existsSync(dir)) return { tasks: [], problems: [] };
  const tasks = [];
  const problems = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    if (isSymlink(file)) {
      problems.push(`${name}: skipped, it is a symbolic link`);
      continue;
    }
    try {
      tasks.push(parseTaskFile(file, name));
    } catch (err) {
      problems.push(/** @type {Error} */ (err).message);
    }
  }
  return { tasks, problems };
}
