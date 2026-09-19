import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAll } from "../src/lib/write-all.mjs";

const MODULE = path.resolve(import.meta.dirname, "../src/lib/write-all.mjs");

/** Run a child that writes `bytes` of a repeating pattern with writeAll, read back slowly. */
function runChild({ bytes, delayMs }) {
  const script = `
    import { writeAll } from ${JSON.stringify(MODULE)};
    const unit = "0123456789abcdef".repeat(64);
    let text = "";
    while (text.length < ${bytes}) text += unit;
    text = text.slice(0, ${bytes});
    writeAll(text);
    process.stderr.write("done");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let received = 0;
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    // Do not read for a while: the pipe fills at 64 KiB and the writer must cope.
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on("data", (d) => {
        received += d.length;
        hash.update(d);
      });
      child.stdout.resume();
    }, delayMs);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, received, digest: hash.digest("hex"), stderr }));
  });
}

const expected = (bytes) => {
  const unit = "0123456789abcdef".repeat(64);
  let text = "";
  while (text.length < bytes) text += unit;
  return createHash("sha256").update(text.slice(0, bytes)).digest("hex");
};

describe("writeAll", () => {
  it("delivers every byte to a pipe whose reader is slow", async () => {
    // A pipe holds 64 KiB. Past that a non-blocking fd answers EAGAIN, and the
    // first version of this function let it escape: the command died with a
    // truncated JSON document and exit 2, but only for a slow reader and only
    // for output over 64 KiB, so it looked like flakiness.
    const bytes = 4 * 1024 * 1024;
    const r = await runChild({ bytes, delayMs: 400 });
    expect(r.stderr).toBe("done");
    expect(r.code).toBe(0);
    expect(r.received).toBe(bytes);
    expect(r.digest).toBe(expected(bytes));
  }, 30_000);

  it("delivers a small write immediately", async () => {
    const r = await runChild({ bytes: 100, delayMs: 0 });
    expect(r).toMatchObject({ code: 0, received: 100, stderr: "done" });
    expect(r.digest).toBe(expected(100));
  });

  it("writes nothing for an empty string", async () => {
    const r = await runChild({ bytes: 0, delayMs: 0 });
    expect(r).toMatchObject({ code: 0, received: 0, stderr: "done" });
  });

  it("rethrows an error that is not EAGAIN instead of spinning", () => {
    const script = `
      import { writeAll } from ${JSON.stringify(MODULE)};
      try { writeAll("hello", 9999); process.stdout.write("no throw"); }
      catch (err) { process.stdout.write(err.code); }
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(r.stdout).toBe("EBADF");
  });

  it("writes to the descriptor it is given", () => {
    const script = `
      import { writeAll } from ${JSON.stringify(MODULE)};
      writeAll("to-stderr", 2);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(r.stderr).toBe("to-stderr");
    expect(r.stdout).toBe("");
  });

  it("defaults to standard output", () => {
    const script = `
      import { writeAll } from ${JSON.stringify(MODULE)};
      writeAll("to-stdout");
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(r.stdout).toBe("to-stdout");
    expect(r.stderr).toBe("");
  });

  it("encodes multi-byte text as UTF-8 and counts bytes, not characters", () => {
    const text = "✓ é ✗ ".repeat(3000);
    const script = `
      import { writeAll } from ${JSON.stringify(MODULE)};
      writeAll(${JSON.stringify(text)});
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    expect(r.stdout.equals(Buffer.from(text))).toBe(true);
  });
});

describe("writeAll in process", () => {
  afterEach(() => vi.restoreAllMocks());

  const eagain = () => Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });

  it("keeps writing from where a partial write stopped until every byte is out", () => {
    const write = vi.spyOn(fs, "writeSync").mockReturnValueOnce(3).mockReturnValueOnce(4).mockReturnValueOnce(3);
    writeAll("0123456789", 7);
    expect(write.mock.calls.map(([fd, , offset]) => [fd, offset])).toEqual([
      [7, 0],
      [7, 3],
      [7, 7],
    ]);
    expect(Buffer.from(write.mock.calls[0][1]).toString()).toBe("0123456789");
  });

  it("waits and retries on EAGAIN instead of failing or spinning", () => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw eagain(); })
      .mockImplementationOnce(() => { throw eagain(); })
      .mockReturnValueOnce(5);
    writeAll("hello", 7);
    expect(write).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls[0].slice(1)).toEqual([0, 0, 2]);
  });

  it("rethrows any other error without waiting", () => {
    const wait = vi.spyOn(Atomics, "wait");
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error("bad fd"), { code: "EBADF" }); });
    expect(() => writeAll("hello", 7)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(wait).not.toHaveBeenCalled();
  });

  it("makes no write call for an empty string", () => {
    const write = vi.spyOn(fs, "writeSync");
    writeAll("", 7);
    expect(write).not.toHaveBeenCalled();
  });

  it("defaults to standard output", () => {
    const write = vi.spyOn(fs, "writeSync").mockReturnValue(1);
    writeAll("x");
    expect(write.mock.calls[0][0]).toBe(process.stdout.fd);
  });

  it("counts bytes rather than characters for multi-byte text", () => {
    const text = "✓é";
    const write = vi.spyOn(fs, "writeSync").mockReturnValue(Buffer.byteLength(text));
    writeAll(text, 7);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1].length).toBe(5);
  });
});
