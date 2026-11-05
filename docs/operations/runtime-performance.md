# Runtime performance and bounded background work

Verified against the offline regressions for the November 2026 runtime audit.
These are implementation contracts, not measured production improvements.

## Conversation search

The HTTP search route uses an asynchronous search index. The EventStore's original
owner reads at most 128 events per page, omitting payloads for non-searchable event
types. A worker receives those pages and owns only a disposable derived SQLite
index in a temporary directory beneath the configured protected Codex private root.
The root is registered with the existing private-path guard before any index bytes
are written. Library callers without a protected cache root use an in-memory index;
search content is never spilled into the shared OS temporary directory. The worker
never opens the retained event database.

The index uses FTS5 trigrams to narrow substring candidates and SQLite LIKE to retain
literal wildcard and case semantics. Searches shorter than three characters run
in the worker too. New events are indexed incrementally. Current registered-session
visibility is checked again after the worker responds. Cancellation stops further
page admission; no query silently falls back to synchronous history scanning.

Cold indexing still takes time proportional to retained history. The protected
disk index uses a bounded SQLite page cache; temporary query data stays in memory
so it cannot escape into a process-wide temporary directory. Broad matches can
therefore still consume query scratch memory. The temporary index has no durability
requirement and is discarded after the worker stops; the original database remains
authoritative.

## Inbox reads

Authenticated feed routes await a shared asynchronous scan. Unchanged files reuse
parsed content by physical identity, size, modification time and change time;
only changed sources update the notification ledger. Archive collisions and
active-source removal retain the existing durable lifecycle semantics.

Content reuse never retains permission. Scans capture current private-path rules,
and the ledger applies its current visibility policy when reading or delivering
records. Failed reconciliation returns an unavailable response instead of a partial
feed. A cold scan still examines all source metadata; large initial imports and
privacy-policy collection should be profiled separately before further changes.

## Preparation, transcript reads and maintenance

- Git configuration parsing is shared only for identical freshly qualified bytes.
  The bounded parse cache does not store checkout validity or execution authority.
- Overlapping transcript reads share work only at the same event revision and
  transcript/cursor boundary. Completed reads and failures are removed immediately.
- Host Git status checks exclude sessions explicitly bound to OpenShell and skip
  missing or non-repository directories before creating a child process.
- Repository validation remains fresh on every configuration load. Diagnostic
  warnings report condition transitions rather than repeating on every reload.
- Failed lifecycle reconciliation backs off for the same retained generation,
  capped at an hour. A new generation or explicit operator preview is not delayed.
  Backoff never changes retained identity, consent or checkpoint records.
- Unavailable-usage warnings report availability transitions, retaining failure
  counts and a recovery event. Slow successful Codex phases remain at info level;
  phase failures remain warnings and retain their trace status.

The historical startup recovery fix remains unchanged. No deployment, retained-data
repair, source configuration removal or automatic sandbox deletion is part of this
change. Validate production latency on a separately authorized deployed release;
threshold-selected warning logs cannot establish all-request percentiles.
