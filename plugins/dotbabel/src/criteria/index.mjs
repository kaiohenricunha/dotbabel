/**
 * Public surface of the criteria core library (P-B1). `dotbabel-criteria.mjs`
 * (P-B2) wraps this in the CLI's list/verify subcommands and the evidence
 * comment.
 */
export { loadCriteria } from "./load.mjs";
export { verifyCriteria, dropPartialLastLine, computeTail, criterionNumber } from "./verify.mjs";
export { parseJUnitReport, parseJUnitText, junitNameMatches, confirmTest, CriteriaReportError } from "./confirm.mjs";
