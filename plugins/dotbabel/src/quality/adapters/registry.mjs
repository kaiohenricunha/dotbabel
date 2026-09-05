import { goAdapter } from "./go.mjs";
import { pythonAdapter } from "./python.mjs";
import { typescriptAdapter } from "./typescript.mjs";
import { javascriptAdapter } from "./javascript.mjs";

/** Explicit built-in adapter registry. Repository code cannot extend it. */
export const QUALITY_ADAPTERS = Object.freeze([goAdapter, pythonAdapter, typescriptAdapter, javascriptAdapter]);

/** Get the built-in adapter for a language, or undefined. */
export function getQualityAdapter(language) {
  return QUALITY_ADAPTERS.find((adapter) => adapter.languages.includes(language));
}
