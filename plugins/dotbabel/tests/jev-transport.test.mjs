import http from "node:http";
import { expect, it } from "vitest";
import { jevAdapter } from "../src/jev-adapter.mjs";
import { decide } from "../src/decider.mjs";
const finding = { file: "a", title: "bug", body: "a condition", diff_hunk: "+true", severity: "important", category: "bug" };
const inputs = { "review-triage": { finding } };
it("a local HTTP fixture verifies transport and the five-second fallback", async () => {
  const requests = [];
  let hang = false;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    if (hang) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { real_defect: { noul: 0.95 } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const fetch = (url, opts) => { expect(url).toBe("https://api.typesafe.ai/v1/systemone"); return globalThis.fetch(`http://127.0.0.1:${server.address().port}`, opts); };
    const adapter = jevAdapter("fixture-canary", { fetch });
    const options = { config: { adapter: "jev", steps: ["review-triage"] }, consent: true, key: "fixture-canary", adapter };
    const result = await decide("review-triage", inputs["review-triage"], options);
    expect(result.shadow.answer).toBe("auto-valid");
    expect(requests[0].auth).toBe("Bearer fixture-canary");
    expect(JSON.stringify(requests[0].body)).not.toContain("fixture-canary");
    hang = true;
    const start = performance.now();
    expect(await decide("review-triage", inputs["review-triage"], options)).toMatchObject({ fallback: true, answer: "full-validation" });
    expect(performance.now() - start).toBeGreaterThanOrEqual(4900);
    expect(performance.now() - start).toBeLessThan(6500);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
