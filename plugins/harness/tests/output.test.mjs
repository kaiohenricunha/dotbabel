import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createOutput } from "../src/lib/output.mjs";

function collect(stream) {
  let buf = "";
  stream.on("data", (chunk) => (buf += chunk.toString("utf8")));
  return () => buf;
}

describe("createOutput — human mode", () => {
  it("prints ✓ for pass, ✗ for fail, ⚠ for warn", () => {
    const stream = new PassThrough();
    const read = collect(stream);
    const out = createOutput({ stream, noColor: true, env: {} });
    out.pass("ok thing");
    out.fail("bad thing");
    out.warn("sketchy thing");
    expect(read()).toContain("✓ ok thing");
    expect(read()).toContain("✗ bad thing");
    expect(read()).toContain("⚠ sketchy thing");
  });

  it("suppresses ANSI when noColor is true", () => {
    const stream = new PassThrough();
    stream.isTTY = true;
    const read = collect(stream);
    const out = createOutput({ stream, noColor: true, env: {} });
    out.fail("x");
    expect(read()).not.toContain("\x1b[");
  });

  it("suppresses ANSI when NO_COLOR env is set regardless of TTY", () => {
    const stream = new PassThrough();
    stream.isTTY = true;
    const read = collect(stream);
    const out = createOutput({ stream, env: { NO_COLOR: "1" } });
    out.fail("x");
    expect(read()).not.toContain("\x1b[");
  });

  it("emits ANSI only when stream is a TTY", () => {
    const tty = new PassThrough();
    tty.isTTY = true;
    const read = collect(tty);
    const out = createOutput({ stream: tty, env: {} });
    out.fail("x");
    expect(read()).toContain("\x1b[31m");
  });

  it("counts pass/fail/warn for the caller", () => {
    const stream = new PassThrough();
    collect(stream);
    const out = createOutput({ stream, noColor: true, env: {} });
    out.pass("a");
    out.pass("b");
    out.fail("c");
    out.warn("d");
    expect(out.counts()).toEqual({ pass: 2, fail: 1, warn: 1 });
  });
});

describe("createOutput — json mode", () => {
  it("buffers events and writes a single JSON object on flush()", () => {
    const stream = new PassThrough();
    const read = collect(stream);
    const out = createOutput({ stream, json: true, env: {} });
    out.pass("a");
    out.fail("b", { code: "X" });
    out.warn("c");
    // nothing written yet
    expect(read()).toBe("");
    out.flush();
    const parsed = JSON.parse(read());
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]).toEqual({ kind: "pass", message: "a" });
    expect(parsed.events[1]).toEqual({
      kind: "fail",
      message: "b",
      details: { code: "X" },
    });
    expect(parsed.counts).toEqual({ pass: 1, fail: 1, warn: 1 });
  });

  it("flush() is a no-op in human mode", () => {
    const stream = new PassThrough();
    const read = collect(stream);
    const out = createOutput({ stream, noColor: true, env: {} });
    out.pass("x");
    const before = read();
    out.flush();
    expect(read()).toBe(before);
  });
});
