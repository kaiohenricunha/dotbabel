import { describe, it, expect, vi, afterEach } from "vitest";
import { debug, isDebug } from "../src/lib/debug.mjs";

describe("debug", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DOTCLAUDE_DEBUG;
  });

  it("is a no-op when DOTCLAUDE_DEBUG is unset", () => {
    delete process.env.DOTCLAUDE_DEBUG;
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    debug("git:x", "msg");
    expect(spy).not.toHaveBeenCalled();
    expect(isDebug()).toBe(false);
  });

  it("writes a tagged line to stderr when DOTCLAUDE_DEBUG=1", () => {
    process.env.DOTCLAUDE_DEBUG = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    debug("git:x", "msg");
    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0][0];
    expect(written).toMatch(/\[harness:git:x\]/);
    expect(written).toMatch(/msg/);
    expect(isDebug()).toBe(true);
  });

  it("stringifies Error args via their stack/message", () => {
    process.env.DOTCLAUDE_DEBUG = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    debug("err", new Error("boom"));
    const written = spy.mock.calls[0][0];
    expect(written).toMatch(/boom/);
  });

  it("stringifies object args via JSON", () => {
    process.env.DOTCLAUDE_DEBUG = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    debug("obj", { k: "v" });
    const written = spy.mock.calls[0][0];
    expect(written).toMatch(/\{"k":"v"\}/);
  });

  it("falls back to String() when JSON.stringify throws", () => {
    process.env.DOTCLAUDE_DEBUG = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const circular = {};
    circular.self = circular;
    debug("cycle", circular);
    expect(spy).toHaveBeenCalledOnce();
  });
});
