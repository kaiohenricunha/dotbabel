# Model Intelligence release snapshots

_Last updated: v4.4.0_

A release snapshot is a reviewed package input. It records accepted runtime selector support and capability facts. It does not prove a user's current entitlement, quota, selected MAIN model or effective effort. Ordinary live routing refuses release-only evidence.

Snapshot reads and offline checks currently require Linux with `/proc/self/fd`. Atomic replacement of an existing snapshot also requires Python 3 and Linux `renameat2` support. Native Windows and macOS snapshot I/O are unavailable in this version; Linux under WSL uses the supported backend.

## Check without discovery

```bash
node plugins/dotbabel/bin/dotbabel-models.mjs snapshot --check --json
node plugins/dotbabel/bin/dotbabel-models.mjs status --json
```

The check validates the schema, content identity and required evidence age without network access or runtime probes. The seven-day release limit fails the explicit check. Plain status still returns information. A published package keeps deterministic build behavior after its evidence becomes old; the build does not recompute freshness to change a model.

## Compare and refresh

```bash
node plugins/dotbabel/bin/dotbabel-models.mjs snapshot --json
node plugins/dotbabel/bin/dotbabel-models.mjs snapshot --write --json
```

The default operation shows the candidate and writes nothing. The explicit write locks the snapshot directory, rechecks Claude selectors in credential-free scratch configuration, validates the complete candidate and replaces the file atomically. The existing source adapter prevents network use and stops before a model turn. A failed source, changed native version or changed alias mapping leaves the committed file untouched.

Rechecking native selectors does not renew provider or documentation evidence. Those dates remain the actual earlier observation dates. Refresh those accepted facts through source research, keep their field provenance, review the candidate, then use the explicit input path:

```bash
node plugins/dotbabel/bin/dotbabel-models.mjs snapshot --evidence-file reviewed-candidate.json --json
node plugins/dotbabel/bin/dotbabel-models.mjs snapshot --write --evidence-file reviewed-candidate.json --json
```

The candidate must already pass the snapshot schema and identity checks. The operation cannot turn unavailable evidence into accepted support or remove an unsatisfied supplied release floor. Review and commit the resulting diff. `--snapshot-file` selects an explicit alternate destination for a maintainer or an isolated test; normal operation uses the single published snapshot. `--check` and `--write` are mutually exclusive.

## Sources and identity

The first snapshot contains six Claude selectors: three full native identifiers and their three measured stable aliases. The isolated 2.1.302 CLI resolves each alias without credentials or inference. The provider recording supplies input context limits. A reviewed bundle of first-party model configuration and model overview facts supplies native effort support, native defaults, reasoning and ordinary tool support for exactly the documented current set. No name spelling becomes a model strength rank. A recorded provider response is not a live entitlement check.

`observedAt` stays in the file for age and provenance. It does not enter `snapshotId`. Source versions, accepted values, field provenance and the verified runtime contract do enter identity. TTL, live availability, computed freshness, refresh state and generated-at fields are rejected. All generated release consumers use this one snapshot and the shared resolver.

Accepted release inclusion produces `releaseEligibility`, which the shared resolver reads only for release-scoped catalogs. It does not create native picker visibility. Changed adapter or source versions cannot renew an older accepted source date. Snapshot destinations cannot replace projection coordination files.
