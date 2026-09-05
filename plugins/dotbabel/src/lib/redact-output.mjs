const RULES = [
  /gh[pso]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /xox[baprs]-[0-9A-Za-z-]{10,}/g,
  /^authorization:\s*bearer\s+\S+/gim,
  /^\s*(?:export\s+)?[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=\S+/gim,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g,
];

/** Redact likely credentials from captured child-process output. */
export function redactOutput(text) {
  return RULES.reduce((value, expression) => value.replace(expression, "[REDACTED]"), String(text));
}
