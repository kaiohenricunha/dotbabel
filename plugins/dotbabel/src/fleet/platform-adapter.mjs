/** Platform capabilities describe implemented backends, not command availability. */
function capability(support, evidence) {
  return { support, network: "never", auth: "none", cacheable: false, execution: "read-only", evidence };
}

/** Return the CPU backend capability descriptor. Unknown systems fail open.
 * @param {string} [platform]
 * @returns {object}
 */
export function platformAdapter(platform = process.platform) {
  const linux = platform === "linux";
  const support = linux ? "supported" : "unsupported";
  return {
    platform,
    lanes: linux,
    capabilities: {
      pin: capability(support, linux ? "fleet-lane.sh: Linux taskset and flock; requires installed tools" : "no verified CPU affinity backend"),
      cpuShare: capability(support, linux ? "cpushare.mjs: systemd user scope CPUWeight; requires cgroup v2 and systemd" : "no verified CPU share backend"),
    },
  };
}

/** Describe platform support for doctor and the fleet CLI.
 * @param {object} adapter
 * @returns {string}
 */
export function describePlatformAdapter(adapter) {
  const states = Object.entries(adapter.capabilities).map(([name, c]) => `${name} ${c.support}`).join(", ");
  return `platform ${adapter.platform}: ${states}${adapter.lanes ? " (requires taskset/flock; cpuShare requires systemd)" : "; CPU lanes are off"}`;
}
