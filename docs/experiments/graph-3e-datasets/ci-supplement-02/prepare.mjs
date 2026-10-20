import fs from "node:fs";
import path from "node:path";
export function scrub(text) {
  return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/g,"[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi,"$1[REDACTED]")
    .replace(/(\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|API_KEY|TOKEN|SECRET|PASSWORD)["']?[^\S\n]*[:=][^\S\n]*["']?)[^\s,"'}]+/gi,"$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,"[REDACTED PRIVATE KEY]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,"$1[REDACTED]@");
}

export function save(file, value) {
  const parent=path.dirname(file);
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  fs.writeFileSync(file,value,{flag:"wx",mode:0o600});
}

