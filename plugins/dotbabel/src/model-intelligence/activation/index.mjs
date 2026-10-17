/**
 * Project-local activation boundary (ARCH-73). No user/global activation exists.
 * Read operations never discover models, invoke a runtime, or write configuration.
 */
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Ajv from "ajv/dist/2020.js";
import { acquireLock } from "../catalog/lock.mjs";

const require = createRequire(import.meta.url);
const schema = require("../../../../../schemas/dotbabel.config.schema.json");
const validate = new Ajv({ strict: false }).compile(schema.properties.model_intelligence);
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Coded error without repository-controlled values or parser excerpts.
 * @param {string} code
 * @returns {Error & {code: string}}
 */
function failure(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Derive effective activation from the supplied project document only.
 * @param {object} document The project's .dotbabel.json document.
 * @returns {{enabled: boolean, routingRequested: boolean, routingEnabled: boolean}}
 */
export function projectActivation(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw failure("invalid_project_config");
  const config = document.model_intelligence === undefined ? {} : document.model_intelligence;
  if (!validate(config)) throw failure("invalid_project_config");
  const enabled = config.enabled === true;
  const routingRequested = config.adaptive_routing?.enabled === true;
  return { enabled, routingRequested, routingEnabled: enabled && routingRequested };
}

/**
 * Read a bounded regular file. A symlink is never followed across project boundaries.
 * @param {string} file
 * @returns {{document: object, mode: number}}
 */
function readDocument(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw failure("project_config_unavailable");
    const text = fs.readFileSync(fd, "utf8");
    let document;
    try { document = JSON.parse(text); }
    catch { throw failure("invalid_project_config"); }
    projectActivation(document);
    return { document, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { document: {}, mode: 0o600 };
    if (["invalid_project_config", "project_config_unavailable"].includes(error.code)) throw error;
    throw failure("project_config_unavailable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Inspect activation with no global fallback, cache access, or runtime operation.
 * @param {string} repoRoot
 * @returns {{enabled: boolean, routingRequested: boolean, routingEnabled: boolean}}
 */
export function readProjectActivation(repoRoot) {
  return projectActivation(readDocument(join(repoRoot, ".dotbabel.json")).document);
}

/**
 * Replace a complete config while preserving its access mode.
 * @param {string} file
 * @param {object} document
 * @param {number} mode
 * @returns {void}
 */
function replaceDocument(file, document, mode) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw failure("project_config_unavailable");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/**
 * Change only the project's activation flags under one read-modify-write lock.
 * Engine disable retains the independent routing preference, but makes it ineffective.
 * Lock contention is bounded; stale ownership uses the existing conservative lock contract.
 * @param {string} repoRoot
 * @param {{enabled?: boolean, routingEnabled?: boolean}} change
 * @returns {{enabled: boolean, routingRequested: boolean, routingEnabled: boolean}}
 */
export function setProjectActivation(repoRoot, change) {
  if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).length === 0 ||
      Object.entries(change).some(([key, value]) => !["enabled", "routingEnabled"].includes(key) || typeof value !== "boolean")) {
    throw failure("invalid_activation_change");
  }
  const file = join(fs.realpathSync(repoRoot), ".dotbabel.json");
  const lockPath = `${file}.model-intelligence.lock`;
  const deadline = Date.now() + 5000;
  let lock;
  do {
    lock = acquireLock(lockPath, { resource: file });
    if (lock.acquired) break;
    if (Date.now() >= deadline) throw failure("project_config_locked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  } while (true);
  try {
    const { document, mode } = readDocument(file);
    const config = document.model_intelligence ?? {};
    if (change.enabled !== undefined) config.enabled = change.enabled;
    if (change.routingEnabled !== undefined) config.adaptive_routing = { ...config.adaptive_routing, enabled: change.routingEnabled };
    document.model_intelligence = config;
    const result = projectActivation(document);
    replaceDocument(file, document, mode);
    return result;
  } finally { lock.release(); }
}
