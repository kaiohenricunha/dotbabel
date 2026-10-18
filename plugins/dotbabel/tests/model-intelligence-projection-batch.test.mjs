import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { materialize } from "../src/model-intelligence/materialize/index.mjs";
import { syncProjectionBatch, validateProjectionBatch } from "../src/model-intelligence/materialize/transaction.mjs";
import { hashContent } from "../src/model-intelligence/materialize/manifest.mjs";

describe("verified release batch transaction", () => {
  it("loads derived release bytes inside the lock and preserves their exact provenance", async () => {
    const root = makeTempDir("mi-release-batch-");
    const batch = materialize(materializationFixture()); const before = structuredClone(batch);
    const result = await syncProjectionBatch({ root, loadBatch: () => {
      expect(fs.existsSync(join(root, ".dotbabel-projection.lock"))).toBe(true);
      return batch;
    } });
    expect(result.status).toBe("synced"); expect(batch).toEqual(before);
    expect(fs.readFileSync(join(root, batch.files[0].path), "utf8")).toBe(batch.files[0].content);
    expect(JSON.parse(fs.readFileSync(join(root, ".dotbabel-projection.json"), "utf8"))).toEqual(batch.manifest);
  });
  it.each(["missing-file", "duplicate-file", "unrecorded-target", "bad-marker", "oversized-file", "recovery-metadata"])("refuses %s before writing any projection", async fault => {
    const root = makeTempDir("mi-invalid-release-"); const batch = materialize(materializationFixture());
    if (fault === "missing-file") batch.files = [];
    if (fault === "duplicate-file") batch.files.push(structuredClone(batch.files[0]));
    if (fault === "unrecorded-target") batch.files[0].path = "other.md";
    if (fault === "bad-marker") {
      batch.files[0].content = "---\nname: handwritten\n---\nmy content\n";
      Object.values(batch.manifest.entries)[0].outputHash = hashContent(batch.files[0].content);
    }
    if (fault === "oversized-file") batch.files[0].content = "a".repeat(4 * 1024 * 1024 + 1);
    if (fault === "recovery-metadata") batch.manifest.retainedEntries = {};
    await expect(syncProjectionBatch({ root, loadBatch: () => batch })).rejects.toThrow(/batch/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("rejects a non-batch and a null committed manifest", () => {
    expect(() => validateProjectionBatch(null)).toThrow(/batch/);
    expect(() => validateProjectionBatch({ files: [], manifest: null })).toThrow(/manifest|batch/);
  });
});
