/** Additive project installation for native peer runtimes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HEADER = "// dotbabel:managed-native-peer:v1";
const SKILL_MARK = "<!-- dotbabel:managed-peer-skill:v1 -->";
const BIN = fileURLToPath(new URL("../../bin/dotbabel-peer.mjs", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function antigravityEvents() {
  const events = {};
  for (const event of ["SessionStart", "PreInvocation", "PreToolUse", "Stop"]) {
    const hook = {
      type: "command",
      command: `${quote(process.execPath)} ${quote(BIN)} hook ${event} --harness antigravity`,
      timeout: 10,
    };
    events[event] = event === "PreToolUse" ? [{ matcher: ".*", hooks: [hook] }] : [hook];
  }
  return events;
}

/** Refuse managed startup unless the native project guard is installed and enabled. @param {string} directory @returns {void} */
export function assertAntigravityHooks(directory) {
  const raw = read(path.join(directory, ".agents/hooks.json"));
  const configured = raw && JSON.parse(raw)["dotbabel-peer"];
  if (!configured || JSON.stringify(configured) !== JSON.stringify(antigravityEvents()))
    throw new Error(
      "Run dotbabel peer setup --harness antigravity in this project before launch; its native hooks must remain enabled.",
    );
}

function safePath(file) {
  let current = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`refusing integration symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function read(file) {
  safePath(file);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function write(file, text) {
  safePath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function managed(file, text, marker = HEADER) {
  const old = read(file);
  if (old !== null && old !== text && !old.includes(marker))
    throw new Error(`refusing to overwrite unmanaged integration: ${file}`);
  write(file, text);
  return file;
}

/** Install one native project adapter and its shared skill; preserve foreign config and native policy. @param {string} harness @param {string} directory @returns {object} */
export function setupNative(harness, directory) {
  const root = path.resolve(directory),
    files = [];
  if (harness === "opencode") {
    const plugin = path.join(root, ".opencode/plugins/dotbabel-peer");
    const url = new URL("./integrations/opencode.mjs", import.meta.url).href;
    files.push(
      managed(
        path.join(plugin, "index.mjs"),
        `${HEADER}\nexport { default } from ${JSON.stringify(url)};\n`,
      ),
    );
    const pkg = path.join(plugin, "package.json"),
      value = { name: "dotbabel-peer", private: true, type: "module", exports: "./index.mjs" };
    if (read(pkg) !== null && JSON.stringify(JSON.parse(read(pkg))) !== JSON.stringify(value))
      throw new Error(`refusing to overwrite unmanaged integration: ${pkg}`);
    write(pkg, JSON.stringify(value, null, 2) + "\n");
    files.push(pkg);
  } else if (harness === "copilot") {
    const url = new URL("./integrations/copilot.mjs", import.meta.url).href;
    files.push(
      managed(
        path.join(root, ".github/extensions/dotbabel-peer/extension.mjs"),
        `${HEADER}\nimport { joinSession } from "@github/copilot-sdk/extension";\nimport { startCopilotPeer } from ${JSON.stringify(url)};\nconst peer = await startCopilotPeer(joinSession, { directory: ${JSON.stringify(root)} });\nprocess.once("SIGTERM", () => { void peer.close().finally(() => process.exit()); });\n`,
      ),
    );
  } else if (harness === "antigravity") {
    const file = path.join(root, ".agents/hooks.json"),
      old = read(file),
      config = old === null ? {} : JSON.parse(old);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("native hooks must be an object");
    const events = antigravityEvents();
    if (
      config["dotbabel-peer"] &&
      JSON.stringify(config["dotbabel-peer"]) !== JSON.stringify(events)
    )
      throw new Error("refusing to overwrite unmanaged dotbabel-peer hooks");
    config["dotbabel-peer"] = events;
    write(file, JSON.stringify(config, null, 2) + "\n");
    files.push(file);
  } else throw new Error("unsupported native harness");
  const source = fileURLToPath(new URL("../../../../skills/peer/SKILL.md", import.meta.url));
  files.push(
    managed(
      path.join(root, ".agents/skills/peer/SKILL.md"),
      fs.readFileSync(source, "utf8") + `\n${SKILL_MARK}\n`,
      SKILL_MARK,
    ),
  );
  return {
    files,
    next:
      harness === "copilot"
        ? "Start Copilot with --experimental. Approve the native extension hooks when prompted; native tool permissions remain active."
        : harness === "opencode"
          ? "Restart OpenCode v2 to load the project plugin. Use the native dotbabel_peer tool."
          : "Use dotbabel peer launch main|advisor CODE --harness antigravity. Ordinary existing Antigravity terminals are not attached.",
  };
}
