/**
 * The fair CPU share of `dotbabel fleet`. Each Claude Code session runs in its
 * own systemd scope in the user manager's app.slice (tmux, for example, makes
 * one per pane). Without CPU weights, the kernel shares the CPUs thread by
 * thread, so a session with 48 busy threads gets 12 times the CPU of one with
 * 4. With an equal CPUWeight on each scope, the scopes share the CPUs as
 * groups, so a light session keeps its CPUs next to a heavy one. Measured on a
 * 16-CPU machine: 1.05 CPUs without the weights, 3.37 of 4 with them.
 *
 * The bin applies the weight with `systemctl --user set-property --runtime`,
 * so it lasts until the next boot.
 */

const DEFAULT_WEIGHT = 100;
const MAX_WEIGHT = 10000;

/**
 * The systemd scope of a process, from the text of /proc/<pid>/cgroup, when
 * it is a scope in the user manager's app.slice. Other cgroups (system
 * services, login sessions, cgroup v1) give null: the share is left alone.
 *
 * @param {string} cgroupText
 * @returns {{path: string, unit: string}|null}
 */
export function sessionScope(cgroupText) {
  const line = String(cgroupText)
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (!line) return null;
  const cgroupPath = line.slice(3).trim();
  const unit = cgroupPath.slice(cgroupPath.lastIndexOf("/") + 1);
  if (!unit.endsWith(".scope") || !/\/user@\d+\.service\/app\.slice\//.test(cgroupPath)) return null;
  return { path: cgroupPath, unit };
}

/**
 * The CPU weight to give each session scope, from DOTBABEL_FLEET_CPU_WEIGHT:
 * unset or empty is 100, an integer from 1 to 10000 is that weight, and "off"
 * or any other value turns the share off.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number|null} null when the share is off
 */
export function cpuWeightSetting(env) {
  const raw = env.DOTBABEL_FLEET_CPU_WEIGHT;
  if (raw === undefined || raw === "") return DEFAULT_WEIGHT;
  if (!/^\d+$/.test(raw)) return null;
  const weight = Number(raw);
  return weight >= 1 && weight <= MAX_WEIGHT ? weight : null;
}

/**
 * The systemctl arguments that give a scope its weight until the next boot.
 *
 * @param {string} unit
 * @param {number} weight
 * @returns {string[]}
 */
export function setPropertyArgs(unit, weight) {
  return ["--user", "set-property", "--runtime", unit, `CPUWeight=${weight}`];
}
