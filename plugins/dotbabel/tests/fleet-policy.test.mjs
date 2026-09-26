// Behavior tests for the pure half of `dotbabel fleet`: repo identity, claim
// matching, the edit decision (allow / deny / ask), and claim-record edits.
// Everything here is a function of its inputs — no filesystem, no processes.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARED_PATHS,
  addClaim,
  decideEdit,
  isSharedPath,
  normalizePattern,
  normalizeRemote,
  patternsOverlap,
  releaseClaims,
  repoSlug,
} from "../src/fleet/policy.mjs";

const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

function owner(key, name, claims, { alive = true } = {}) {
  return {
    key,
    name,
    status: "busy",
    alive,
    claims: claims.map((c) => ({
      source: "auto",
      branch: "feat/x",
      worktree: "/repo",
      note: null,
      active: true,
      ...c,
    })),
  };
}

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:kaiohenricunha/dotbabel.git", "github.com/kaiohenricunha/dotbabel"],
    ["https://github.com/kaiohenricunha/dotbabel", "github.com/kaiohenricunha/dotbabel"],
    ["https://user:token@GitHub.com/kaiohenricunha/dotbabel.git/", "github.com/kaiohenricunha/dotbabel"],
    ["ssh://git@github.com:22/kaiohenricunha/dotbabel.git", "github.com/kaiohenricunha/dotbabel"],
  ])("maps %s to one key for every clone", (url, key) => {
    expect(normalizeRemote(url)).toBe(key);
  });

  it.each(["", "   ", "/srv/git/repo.git", "file:///srv/git/repo.git", "not a url"])(
    "returns null for %j, which names no shared host",
    (url) => {
      expect(normalizeRemote(url)).toBeNull();
    },
  );
});

describe("repoSlug", () => {
  it("turns a repo key into one safe directory name", () => {
    expect(repoSlug("github.com/kaiohenricunha/dotbabel")).toBe("github.com_kaiohenricunha_dotbabel");
    expect(repoSlug("local:/home/me/repo/.git")).toBe("local_home_me_repo_.git");
  });
});

describe("normalizePattern", () => {
  it("cleans a repo-relative pattern", () => {
    expect(normalizePattern("./docs/hooks.md")).toBe("docs/hooks.md");
    expect(normalizePattern("docs//sub/")).toBe("docs/sub");
    expect(normalizePattern("docs\\sub\\a.md")).toBe("docs/sub/a.md");
    expect(normalizePattern("plugins/dotbabel/src/fleet/**")).toBe("plugins/dotbabel/src/fleet/**");
  });

  it.each(["", "  ", "./", "/etc/passwd", "../outside", "docs/../../x", "C:\\repo\\x"])(
    "rejects %j, which is empty or leaves the repo",
    (input) => {
      expect(() => normalizePattern(input)).toThrow(/pattern/i);
    },
  );
});

describe("isSharedPath", () => {
  it("exempts lockfiles and changelogs at any depth", () => {
    for (const rel of ["package-lock.json", "plugins/x/package-lock.json", "go.sum", "CHANGELOG.md"]) {
      expect(isSharedPath(rel)).toBe(true);
    }
  });

  it("does not exempt package.json, a real conflict point", () => {
    expect(isSharedPath("package.json")).toBe(false);
    expect(DEFAULT_SHARED_PATHS).not.toContain("package.json");
  });

  it("adds a repo's own shared globs", () => {
    expect(isSharedPath("docs/generated/a.md")).toBe(false);
    expect(isSharedPath("docs/generated/a.md", ["docs/generated/**"])).toBe(true);
  });
});

describe("patternsOverlap", () => {
  it.each([
    ["docs/hooks.md", "docs/hooks.md", true],
    ["docs", "docs/hooks.md", true],
    ["docs/hooks.md", "docs/cli.md", false],
    ["docs/*.md", "docs/hooks.md", true],
    ["docs/*.md", "docs/sub/x.md", false],
    ["plugins/dotbabel/src", "plugins/dotbabel/src/fleet/**", true],
    ["plugins/dotbabel/src/fleet/**", "plugins/dotbabel/src/quality/**", false],
    ["src/**", "src/fleet/*.mjs", true],
    ["docs-old/x", "docs/x", false],
  ])("%s vs %s → %s, in either order", (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });
});

describe("decideEdit", () => {
  const base = { rel: "docs/hooks.md", selfKey: "100-1", now: T0, escalateAfterMs: 15 * MIN };

  it("allows and asks for a claim when nobody claims the path", () => {
    expect(decideEdit({ ...base, owners: [] })).toEqual({ action: "allow", claimNeeded: true });
  });

  it("allows without a new claim when this session already covers the path", () => {
    const self = owner("100-1", "me", [{ pattern: "docs/**", source: "explicit", claimedAt: iso(T0 - MIN) }]);
    expect(decideEdit({ ...base, owners: [self] })).toEqual({ action: "allow", claimNeeded: false });
  });

  it("denies when a live peer claims the exact path", () => {
    const peer = owner("200-2", "dotbabel-45", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - 5 * MIN) }]);
    const d = decideEdit({ ...base, owners: [peer] });
    expect(d.action).toBe("deny");
    expect(d.conflict.owner.name).toBe("dotbabel-45");
    expect(d.conflict.claim.pattern).toBe("docs/hooks.md");
    expect(d.firstDeniedAt).toBe(iso(T0));
    expect(d.escalateAt).toBe(iso(T0 + 15 * MIN));
  });

  it("denies when a live peer's glob covers the path", () => {
    const peer = owner("200-2", "peer", [{ pattern: "docs/**", source: "explicit", claimedAt: iso(T0 - MIN) }]);
    expect(decideEdit({ ...base, owners: [peer] }).action).toBe("deny");
  });

  it("ignores the claim of a session that exited", () => {
    const peer = owner("200-2", "gone", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - MIN) }], { alive: false });
    expect(decideEdit({ ...base, owners: [peer] })).toEqual({ action: "allow", claimNeeded: true });
  });

  it("ignores a claim whose worktree was removed", () => {
    const peer = owner("200-2", "done", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - MIN), active: false }]);
    expect(decideEdit({ ...base, owners: [peer] }).action).toBe("allow");
  });

  it("blocks with the earliest of several conflicting claims", () => {
    const late = owner("300-3", "late", [{ pattern: "docs", claimedAt: iso(T0 - MIN) }]);
    const early = owner("200-2", "early", [{ pattern: "docs/*.md", claimedAt: iso(T0 - 9 * MIN) }]);
    expect(decideEdit({ ...base, owners: [late, early] }).conflict.owner.name).toBe("early");
  });

  describe("two sessions that claimed the same path in a race", () => {
    it("keeps the path for the session that claimed it first", () => {
      const self = owner("100-1", "me", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - 2 * MIN) }]);
      const peer = owner("200-2", "peer", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - MIN) }]);
      expect(decideEdit({ ...base, owners: [self, peer] }).action).toBe("allow");
    });

    it("makes the later session yield", () => {
      const self = owner("100-1", "me", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - MIN) }]);
      const peer = owner("200-2", "peer", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - 2 * MIN) }]);
      expect(decideEdit({ ...base, owners: [self, peer] }).action).toBe("deny");
    });

    it("breaks an exact tie by owner key, so both sides agree", () => {
      const at = iso(T0 - MIN);
      const low = owner("100-1", "low", [{ pattern: "docs/hooks.md", claimedAt: at }]);
      const high = owner("200-2", "high", [{ pattern: "docs/hooks.md", claimedAt: at }]);
      expect(decideEdit({ ...base, selfKey: "100-1", owners: [low, high] }).action).toBe("allow");
      expect(decideEdit({ ...base, selfKey: "200-2", owners: [low, high] }).action).toBe("deny");
    });
  });

  describe("escalation to the user", () => {
    const peer = owner("200-2", "peer", [{ pattern: "docs/hooks.md", claimedAt: iso(T0 - 30 * MIN) }]);

    it("asks the user once the owner held the path past the window", () => {
      const denial = { owner: "200-2", firstDeniedAt: iso(T0 - 16 * MIN) };
      const d = decideEdit({ ...base, owners: [peer], denial });
      expect(d.action).toBe("ask");
      expect(d.since).toBe(iso(T0 - 16 * MIN));
    });

    it("keeps denying inside the window, from the first block's time", () => {
      const denial = { owner: "200-2", firstDeniedAt: iso(T0 - 10 * MIN) };
      const d = decideEdit({ ...base, owners: [peer], denial });
      expect(d.action).toBe("deny");
      expect(d.firstDeniedAt).toBe(iso(T0 - 10 * MIN));
      expect(d.escalateAt).toBe(iso(T0 + 5 * MIN));
    });

    it("restarts the window when a different session now owns the path", () => {
      const denial = { owner: "999-9", firstDeniedAt: iso(T0 - 60 * MIN) };
      const d = decideEdit({ ...base, owners: [peer], denial });
      expect(d.action).toBe("deny");
      expect(d.firstDeniedAt).toBe(iso(T0));
    });

    it("never escalates when the window is 0", () => {
      const denial = { owner: "200-2", firstDeniedAt: iso(T0 - 999 * MIN) };
      const d = decideEdit({ ...base, owners: [peer], denial, escalateAfterMs: 0 });
      expect(d.action).toBe("deny");
      expect(d.escalateAt).toBeNull();
    });
  });
});

describe("addClaim / releaseClaims", () => {
  const record = {
    schema: 1,
    repo: "github.com/acme/widget",
    owner: { key: "100-1", pid: 100, procStart: "1", sessionId: "s", name: "me" },
    claims: [],
    updatedAt: iso(T0),
  };

  it("adds a claim without changing the input record", () => {
    const claim = { pattern: "docs/a.md", source: "auto", claimedAt: iso(T0 + MIN) };
    const next = addClaim(record, claim);
    expect(next.claims).toEqual([claim]);
    expect(next.updatedAt).toBe(iso(T0 + MIN));
    expect(record.claims).toEqual([]);
  });

  it("replaces a claim with the same pattern instead of adding a copy", () => {
    const one = addClaim(record, { pattern: "src/**", source: "explicit", claimedAt: iso(T0), note: "old" });
    const two = addClaim(one, { pattern: "src/**", source: "explicit", claimedAt: iso(T0 + MIN), note: "new" });
    expect(two.claims).toHaveLength(1);
    expect(two.claims[0].note).toBe("new");
  });

  it("releases an exact pattern, and file claims that a released glob covers", () => {
    let r = record;
    for (const pattern of ["docs/a.md", "docs/sub/b.md", "docs/**", "src/c.mjs"]) {
      r = addClaim(r, { pattern, source: "auto", claimedAt: iso(T0) });
    }
    const { record: next, removed } = releaseClaims(r, ["docs/**"]);
    expect(removed.map((c) => c.pattern).sort()).toEqual(["docs/**", "docs/a.md", "docs/sub/b.md"]);
    expect(next.claims.map((c) => c.pattern)).toEqual(["src/c.mjs"]);
  });

  it("does not release a broader glob when asked for a narrower one", () => {
    const r = addClaim(record, { pattern: "docs/**", source: "explicit", claimedAt: iso(T0) });
    const { removed } = releaseClaims(r, ["docs/a.md"]);
    expect(removed).toEqual([]);
  });

  it("releases everything with 'all'", () => {
    const r = addClaim(addClaim(record, { pattern: "a", claimedAt: iso(T0) }), { pattern: "b", claimedAt: iso(T0) });
    const { record: next, removed } = releaseClaims(r, "all");
    expect(removed).toHaveLength(2);
    expect(next.claims).toEqual([]);
  });
});
