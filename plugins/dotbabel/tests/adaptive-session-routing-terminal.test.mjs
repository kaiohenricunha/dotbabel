import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInterface } from "node:readline";
import { openCodexSession } from "../src/adaptive-session-routing/client.mjs";
import { runManagedTerminal } from "../src/adaptive-session-routing/terminal.mjs";
vi.mock("node:readline", () => ({ createInterface: vi.fn() }));
vi.mock("../src/adaptive-session-routing/client.mjs", () => ({ openCodexSession: vi.fn() }));
let queue, session, input, output, errorOutput, originalExit, ttyDescriptor;
const completed = () => ({ status: "completed", requested: { model: "selected" }, effective: { state: "unknown" }, diagnostics: [], decision: { diagnostics: [{ code: "configuration_proposed" }] } });
beforeEach(() => {
  originalExit = process.exitCode; process.exitCode = undefined;
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  queue = []; output = []; errorOutput = [];
  vi.spyOn(process.stdout, "write").mockImplementation(text => { output.push(text); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(text => { errorOutput.push(text); return true; });
  input = { close: vi.fn(), [Symbol.asyncIterator]: () => ({ next: async () => queue.length ? { done: false, value: queue.shift() } : { done: true } }) };
  createInterface.mockReturnValue(input);
  session = { threadId: "same-thread", native: { approvalPolicy: "on-request" }, close: vi.fn(), submit: vi.fn(async () => completed()) };
  openCodexSession.mockResolvedValue(session);
});
afterEach(() => {
  process.exitCode = originalExit;
  if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor); else delete process.stdin.isTTY;
  vi.restoreAllMocks(); vi.clearAllMocks();
});
it("forwards ordinary text lines once and skips blank lines without rewriting whitespace", async () => {
  queue.push("  First prompt.  ", " ", "Second prompt.");
  await runManagedTerminal({ repoRoot: "/project", model: "auto", effort: "high", json: true });
  expect(session.submit.mock.calls).toEqual([[ [{ type: "text", text: "  First prompt.  ", text_elements: [] }] ], [ [{ type: "text", text: "Second prompt.", text_elements: [] }] ]]);
  expect(openCodexSession.mock.calls[0][0]).toMatchObject({ repoRoot: "/project", model: "auto", effort: "high" });
  expect(output.map(JSON.parse).map(row => row.type)).toEqual(["session", "turn", "turn"]);
  expect(session.close).toHaveBeenCalledOnce(); expect(input.close).toHaveBeenCalledOnce();
});
it("prints human assistant text and a truthful requested/effective turn report", async () => {
  queue.push("Prompt");
  session.submit.mockImplementation(async () => {
    const options = openCodexSession.mock.calls[0][0];
    options.onEvent({ method: "other", params: { delta: "ignore" } });
    options.onEvent({ method: "item/agentMessage/delta", params: {} });
    options.onEvent({ method: "item/agentMessage/delta", params: { delta: "Actual response" } });
    return completed();
  });
  await runManagedTerminal({ repoRoot: "/project" });
  expect(output.join("")).toBe("Actual response"); expect(errorOutput.join("")).toContain("effective {\"state\":\"unknown\"}");
  expect(errorOutput.join("")).toContain("configuration_proposed");
});
it("streams assistant text as JSON records in JSON mode", async () => {
  queue.push("Prompt"); session.submit.mockImplementation(async () => {
    openCodexSession.mock.calls[0][0].onEvent({ method: "item/agentMessage/delta", params: { delta: "Response" } }); return completed();
  });
  await runManagedTerminal({ repoRoot: "/project", json: true });
  expect(output.map(JSON.parse)).toContainEqual({ type: "assistant-text", text: "Response" });
});
it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("requires an explicit interactive accept for %s", async method => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true }); queue.push("Prompt", "accept");
  let answer; session.submit.mockImplementation(async () => { answer = await openCodexSession.mock.calls[0][0].onServerRequest(method, { command: ["test"] }); return completed(); });
  await runManagedTerminal({ repoRoot: "/project" }); expect(answer).toEqual({ decision: "accept" }); expect(errorOutput.join("")).toContain("Native approval request"); expect(errorOutput.join("")).toContain("You> ");
});
it.each(["decline", "yes", "", null])("declines any native approval answer other than accept: %s", async response => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true }); queue.push("Prompt"); if (response !== null) queue.push(response);
  let answer; session.submit.mockImplementation(async () => { answer = await openCodexSession.mock.calls[0][0].onServerRequest("item/commandExecution/requestApproval", {}); return completed(); });
  await runManagedTerminal({ repoRoot: "/project" }); expect(answer).toEqual({ decision: "decline" });
});
it.each([false, true])("never approves an unsupported native request with tty=%s", async tty => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: tty }); queue.push("Prompt", "accept");
  session.submit.mockImplementationOnce(async () => {
    await expect(openCodexSession.mock.calls[0][0].onServerRequest("item/permissions/requestApproval", {})).rejects.toThrow("native_handler_unavailable"); return completed();
  });
  await runManagedTerminal({ repoRoot: "/project" });
});
it("never treats piped prompt text as native permission approval", async () => {
  queue.push("Prompt", "accept"); session.submit.mockImplementationOnce(async () => {
    await expect(openCodexSession.mock.calls[0][0].onServerRequest("item/commandExecution/requestApproval", {})).rejects.toThrow("native_handler_unavailable"); return completed();
  });
  await runManagedTerminal({ repoRoot: "/project" }); expect(session.submit).toHaveBeenCalledTimes(2);
});
it.each(["uncertain", "failed", "interrupted"])("stops after %s with exit 2 and never consumes the next prompt", async status => {
  queue.push("First", "Second"); session.submit.mockResolvedValue({ status, effective: { state: "unknown" }, diagnostics: [{ code: "native_failure" }] });
  await runManagedTerminal({ repoRoot: "/project" }); expect(process.exitCode).toBe(2); expect(session.submit).toHaveBeenCalledOnce(); expect(queue).toEqual(["Second"]);
});
it("reports policy blocking with exit 1 and no effective claim", async () => {
  queue.push("Prompt"); session.submit.mockResolvedValue({ status: "blocked", effective: { state: "unknown" }, diagnostics: [{ code: "routing_blocked" }] });
  await runManagedTerminal({ repoRoot: "/project", json: true }); expect(process.exitCode).toBe(1); expect(output.map(JSON.parse)[1].effective).toEqual({ state: "unknown" });
});
it("closes the session and input when native submission throws", async () => {
  queue.push("Prompt"); session.submit.mockRejectedValue(Error("native_completion_unknown"));
  await expect(runManagedTerminal({ repoRoot: "/project" })).rejects.toThrow("native_completion_unknown"); expect(session.close).toHaveBeenCalledOnce(); expect(input.close).toHaveBeenCalledOnce();
});
it("closes input on initialization failure and removes its signal handler", async () => {
  const count = process.listenerCount("SIGINT"); openCodexSession.mockRejectedValue(Error("routing_disabled"));
  await expect(runManagedTerminal({ repoRoot: "/project" })).rejects.toThrow("routing_disabled"); expect(input.close).toHaveBeenCalledOnce(); expect(process.listenerCount("SIGINT")).toBe(count);
});
it("stops on an interrupt without submitting another prompt", async () => {
  queue.push("First", "Second"); session.submit.mockImplementationOnce(async () => { process.emit("SIGINT"); return completed(); });
  await runManagedTerminal({ repoRoot: "/project" }); expect(process.exitCode).toBe(130); expect(session.submit).toHaveBeenCalledOnce(); expect(input.close).toHaveBeenCalled(); expect(session.close).toHaveBeenCalled();
});
