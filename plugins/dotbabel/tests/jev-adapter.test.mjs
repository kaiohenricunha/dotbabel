import { expect, it, vi } from "vitest";
import { jevAdapter, jevRequest, JEV_MODEL } from "../src/jev-adapter.mjs";
import { decide } from "../src/decider.mjs";

const finding = { file: "a", title: "bug", body: "a condition", diff_hunk: "+true", severity: "important", category: "bug" };
const inputs = { "review-triage": { finding }, retry: { phase: "review-pr", attempt: 1, failure_tail: "failure" }, dispatch: { profile: ["security-auditor"], changed_files: ["a"], changed_lines: 1, candidates: ["architect-reviewer"] } };
const response = (answers, status = 200, headers = {}) => new Response(JSON.stringify({ answers }), { status, headers });
it("asks typed questions with only the documented step input", () => {
  for (const [step, input] of Object.entries(inputs)) {
    const request = jevRequest(step, input);
    expect(request.model).toBe(JEV_MODEL);
    expect(JSON.parse(request.state)).toEqual(input);
    expect(Object.values(request.questions).every((q) => ["noul", "choice"].includes(q.type))).toBe(true);
    for (const question of Object.values(request.questions)) {
      expect(question.instructions.length).toBeGreaterThan(0);
      expect(Object.keys(question.criteria).length).toBeGreaterThan(0);
      expect(Object.values(question.criteria).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    }
  }
});
it("decodes triage, retry, and reviewer answers", async () => {
  const cases = [["review-triage", { real_defect: { noul: 0.95 } }, "auto-valid"], ["review-triage", { real_defect: { noul: 0.05 } }, "auto-false-positive"], ["review-triage", { real_defect: { noul: 0.5 } }, "full-validation"], ["retry", { action: { choice: "fix", confidence: 0.9 } }, "fix"], ["dispatch", { reviewer_0: { noul: 0.95 } }, ["architect-reviewer"]]];
  for (const [step, answers, answer] of cases) {
    const adapter = jevAdapter("canary", { fetch: async () => response(answers) });
    expect((await adapter(step, inputs[step], { signal: new AbortController().signal })).answer).toEqual(answer);
  }
});
it("retries transient responses and stops on authentication failure", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({}, 429, { "retry-after": "0" })).mockResolvedValueOnce(response({ real_defect: { noul: 0.9 } }));
  await jevAdapter("key", { fetch })("review-triage", inputs["review-triage"], { signal: new AbortController().signal });
  expect(fetch).toHaveBeenCalledTimes(2);
  const denied = vi.fn(async () => response({}, 401));
  await expect(jevAdapter("key", { fetch: denied })("retry", inputs.retry, { signal: new AbortController().signal })).rejects.toThrow("adapter request failed");
  expect(denied).toHaveBeenCalledTimes(1);
});
it("invalid probabilities and choices fail rather than fabricate an answer", async () => {
  for (const [step, answers] of [["review-triage", {}], ["retry", { action: { choice: "bypass", confidence: 1 } }], ["dispatch", {}]]) {
    await expect(jevAdapter("key", { fetch: async () => response(answers) })(step, inputs[step], { signal: new AbortController().signal })).rejects.toThrow();
  }
});
it("server failures retry within a fixed limit and missing credentials never send a request", async () => {
  const fetch = vi.fn(async () => response({}, 503, { "retry-after": "0" }));
  await expect(jevAdapter("key", { fetch })("retry", inputs.retry, { signal: new AbortController().signal })).rejects.toThrow(/failed/);
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockClear();
  await expect(jevAdapter("", { fetch })("retry", inputs.retry, { signal: new AbortController().signal })).rejects.toThrow(/key/);
  expect(fetch).not.toHaveBeenCalled();
});
it("the transport binds authorization and the exact typed request without logging a key", async () => {
  const fetch = vi.fn(async () => response({ real_defect: { noul: 0.9 } }));
  const result = await jevAdapter("unit-canary", { fetch })("review-triage", inputs["review-triage"], { signal: new AbortController().signal });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer unit-canary", "Content-Type": "application/json" } });
  expect(JSON.parse(options.body)).toEqual(jevRequest("review-triage", inputs["review-triage"]));
  expect(result).toEqual({ answer: "auto-valid", confidence: 0.9 });
  expect(JSON.stringify(result)).not.toContain("unit-canary");
});
it("probability bands include both thresholds and reviewer confidence uses the least certain answer", async () => {
  const invoke = (step, input, answers) => jevAdapter("key", { fetch: async () => response(answers) })(step, input, { signal: new AbortController().signal });
  expect(await invoke("review-triage", inputs["review-triage"], { real_defect: { noul: 0.1 } })).toEqual({ answer: "auto-false-positive", confidence: 0.9 });
  for (const choice of ["retry", "fix", "ask-owner"]) expect(await invoke("retry", inputs.retry, { action: { choice, confidence: 0.8 } })).toEqual({ answer: choice, confidence: 0.8 });
  const dispatch = { ...inputs.dispatch, candidates: ["architect-reviewer", "documentation-writer"] };
  const result = await invoke("dispatch", dispatch, { reviewer_0: { noul: 0.9 }, reviewer_1: { noul: 0.2 } });
  expect(result.answer).toEqual(["architect-reviewer"]);
  expect(result.confidence).toBeCloseTo(0.8);
  expect(await invoke("dispatch", { ...dispatch, candidates: [] }, {})).toEqual({ answer: [], confidence: 1 });
});
it("backoff grows between transient failures and cancellation ends the wait", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn().mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response({}, 500)).mockResolvedValue(response({ real_defect: { noul: 0.9 } }));
    const result = jevAdapter("key", { fetch })("review-triage", inputs["review-triage"], { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(100); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(3);
    expect((await result).answer).toBe("auto-valid");
    const controller = new AbortController();
    const pending = jevAdapter("key", { fetch: async () => response({}, 500) })("retry", inputs.retry, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
  } finally { vi.useRealTimers(); }
});
