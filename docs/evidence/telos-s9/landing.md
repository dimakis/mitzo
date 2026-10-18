# Required accepted-base integration

PR1018's original head `72f8df4d9c0ff15bcac27a0424461c2a05ed4dc8` passed
all CI on its first run and received Centaur review **5560361972**: LGTM,
recommendation `merge`, zero new/unresolved blockers. The core job took 17 minutes.
See [first-pass CI](first-pass-ci.json) and [first review](first-review.json).

Protected `main` then required this branch to include accepted PR1006 at
`fea33e215b0d1bcf29604aa13e793329588a2980`. That change admits published tools on
supported Codex routes and affects a shared native queue owner. It was integrated
by merging accepted main, preserving branch history and all original evidence.
No production changes were authored in this lane. The PR diff against its new
base still contains only dedicated S9 tests and evidence.

The original 44-row map, source hashes and result files remain exact snapshots of
their original run. This supplement revalidates their available tested subsets
on the newer combined accepted base; it does not turn their pending rows into
acceptance. [Landing source hashes](landing-source.json) pin the refreshed owners.

After integration, using one local worker and a 1 GiB Node heap:

- [49 focused offline checks passed](landing-offline-tests.json), no skips:
  the eight new integration/ledger checks plus the 41 selected shared-owner
  regressions, including fake native RPC interruption and output attribution.
- [Two canonical advisor contracts remain red](landing-canonical-advisor-red.json)
  on the missing `categories` column. S5a retains the fix; no owner production or
  unit-test files were edited to make them pass.
- [Run/source/test hashes](landing-results.json) distinguish these results from
  the original evidence. Core CI and exact-head final review must run again after
  this required base integration; the original approval alone cannot authorize it.

The original map's owners, pending contracts, historical failures and frozen
approval references remain authoritative. S5/S5a/S5b complete journeys, S6–S8
contracts, CT20 final visuals and CT19's separately authorized single-runtime
window remain outstanding. S9 and parent remain active. There were no live model,
Mitzo runtime, staging or deployment operations.
