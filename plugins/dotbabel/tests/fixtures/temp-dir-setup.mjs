// Loaded through `setupFiles` in vitest.config.mjs, so it runs in every test
// file: this afterAll removes the tempdirs temp-dir.mjs handed out while no
// test was running.

import { afterAll } from "vitest";
import { removePendingTempPaths } from "./temp-dir.mjs";

afterAll(removePendingTempPaths);
