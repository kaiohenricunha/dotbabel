import { describe, expect, it } from "vitest";

import { redactOutput } from "../src/lib/redact-output.mjs";

describe("redactOutput", () => {
  it("redacts a token/key/secret assignment embedded mid-line", () => {
    const text = 'curl --header "x-api-' + 'token=abcdef0123456789" https://example.com';
    expect(redactOutput(text)).not.toMatch(/abcdef0123456789/);
  });

  it("redacts a bearer token embedded inside a longer line", () => {
    const text = '{"headers":{"authorization":"Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789"}}';
    expect(redactOutput(text)).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  it("redacts a GitHub fine-grained personal access token", () => {
    const text = `token: ${"github_pat_"}${"A".repeat(22)}`;
    expect(redactOutput(text)).not.toMatch(/github_pat_A+/);
  });

  it("redacts credentials embedded in a URL", () => {
    const text = "cloning https://oauth2:" + "ghp_" + "abcdefghijklmnopqrstuvwx1234" + "@github.com/org/repo.git";
    const redacted = redactOutput(text);
    expect(redacted).not.toMatch(/oauth2:ghp_[A-Za-z0-9]+@/);
  });

  it("still redacts the original anchored shapes", () => {
    expect(redactOutput("export MY_SECRET_" + "TOKEN=abc123\n")).not.toMatch(/abc123/);
    expect(redactOutput("Authorization: Bearer " + "abcdefghij.klmnopqrst.uvwxyz012345\n")).not.toMatch(/abcdefghij\.klmnopqrst\.uvwxyz012345/);
  });
});
