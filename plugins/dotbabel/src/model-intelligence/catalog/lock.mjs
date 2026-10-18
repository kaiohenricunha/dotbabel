/**
 * Capability-cache lock contract. The shared implementation preserves the
 * Model Intelligence REL-3 minimum age and all existing public exports.
 */
/** @typedef {import("../../lib/process-lock.mjs").LockOwner} LockOwner */
/** @typedef {import("../../lib/process-lock.mjs").LockVerdict} LockVerdict */
export {
  STALE_LOCK_MIN_AGE_MS,
  isPidAlive,
  processStartIdentity,
  judgeLock,
  readLockOwner,
  acquireLock,
} from "../../lib/process-lock.mjs";
