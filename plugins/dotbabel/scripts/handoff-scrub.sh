#!/usr/bin/env bash
# handoff-scrub.sh — apply redaction patterns to stdin, write result to stdout.
#
# Prints `scrubbed:<N>` on stderr (N may be 0).
# Exits 0 on success, non-zero only on I/O error.
#
# Patterns are authoritatively documented in
# skills/handoff/references/redaction.md. The unit test handoff-scrub.bats
# cross-checks the script against that table — if you add a pattern
# here, update the table and the test in the same commit.

set -euo pipefail

if ! command -v perl >/dev/null 2>&1; then
  printf 'handoff-scrub: perl is required on PATH\n' >&2
  exit 2
fi

perl -e '
use strict;
use warnings;

my $count = 0;
my $buf = do { local $/; <STDIN> };
$buf = "" unless defined $buf;

# Each s///g in scalar context returns the number of substitutions (or
# "" for zero, which coerces to 0 when added). Do not use the () = ...
# list-context trick here — it misreports 0 as 1 for s///g without
# captures.
my $n;
$n = $buf =~ s/gh[pso]_[A-Za-z0-9]{20,}/<redacted:github-token>/g;                 $count += $n || 0;
$n = $buf =~ s/sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/<redacted:openai-or-sk>/g;          $count += $n || 0;
$n = $buf =~ s/AKIA[0-9A-Z]{16}/<redacted:aws-access-key>/g;                        $count += $n || 0;
$n = $buf =~ s/AIza[0-9A-Za-z_-]{35}/<redacted:google-api-key>/g;                   $count += $n || 0;
$n = $buf =~ s/xox[baprs]-[0-9A-Za-z-]{10,}/<redacted:slack-token>/g;               $count += $n || 0;
$n = $buf =~ s/^authorization:\s*bearer\s+\S+/<redacted:auth-bearer>/gim;           $count += $n || 0;
$n = $buf =~ s/^\s*(?:export\s+)?[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=\S+/<redacted:env-secret>/gim; $count += $n || 0;
$n = $buf =~ s/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/<redacted:pem-private-key>/g; $count += $n || 0;

print $buf;
print STDERR "scrubbed:$count\n";
'
