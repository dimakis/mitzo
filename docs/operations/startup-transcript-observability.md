# Startup and transcript performance observations

Implementation and offline verification: 6 November 2026. Deployment and production
latency improvement remain unverified. This extends the existing runtime performance
work; it does not replace its read coalescing, source ownership or fresh authority checks.

## New-chat preparation

Existing `local_codex.repository_selection`, `repository_reservation` and `bootstrap`
spans remain the aggregate boundaries. Their children now distinguish:

| Span suffix                    | Work observed                                                 |
| ------------------------------ | ------------------------------------------------------------- |
| `repository_base_resolution`   | Local Git default-branch, remote and tracking selection       |
| `repository_fetch`             | The actual Git fetch, once per acquisition                    |
| `repository_commit_resolution` | Resolve the selected commit after acquisition                 |
| `bootstrap_qualification`      | Fresh runtime/source qualification before the bootstrap claim |
| `bootstrap_login`              | Capture or reopen login custody                               |
| `bootstrap_executable`         | Capture or reopen the executable under existing custody       |
| `bootstrap_connect`            | Launch/connect and initialize the owned native client         |

MCP startup retains `mcp.startup.connect` and `mcp.startup.list_tools`. The standard
stdio connector adds `spawn` inside `initialize`, inside `connect`: the SDK starts
its transport once during the connection handshake. These are nested durations;
do not add them together. An injected custom connector retains only its aggregate
connection timing. Independent sources still connect concurrently and retain their
existing cancellation, grants, environment snapshots and shutdown owners.

Every MCP startup phase includes its configured index, fixed `stdio` transport
label and `mcp.source.id`: the first 16 hexadecimal characters of SHA-256 of the
configured alias. This permits comparison across reordered configurations without
exporting aliases, commands, paths, environment variables or upstream errors. It is
a diagnostic correlation key, not an authorization or configuration receipt. For
known aliases, compute the same digest locally to map an observation. The server's
existing startup log lists the configured aliases.

These observations do not remove acquisition or executable-integrity checks, make
MCP startup lazy, share authenticated peers between sessions, or claim a new startup
latency. The repeated native measurements still hash fresh bytes at their existing
qualification boundaries.

## Transcript reads and response delivery

`createSessionTranscriptReader` owns the shared history-reading implementation,
independently of chat/provider orchestration. The EventStore continues to own the
database, payload decoding and cursor boundaries. The existing pure projector
retains replies, delayed tool results, source provenance and seat/subagent handling.
An empty full-transcript event prefix proceeds directly to the existing legacy
reader, avoiding a second event query through `getMessages`.

`transcript.request` records a SHA-256 session fingerprint using the same 16-hex
projection, fixed variant (`messages`, `transcript`, `reconnect`, `durable`), message
count and whether this request joins existing in-flight work. The ordinary reader
adds session age from its already-read metadata. Coalescing does not retain completed
history or merge different revisions/cursors. A shared read belongs to its original
request context; each caller still observes its own serialization and response write.

| Child span | Meaning |

| `transcript.read`               | The shared read, including the durable owner when that variant is selected |
| ------------------------------- | -------------------------------------------------------------------------- |
| `transcript.events_read`        | EventStore row acquisition and decoding, plus event count                  |
| `transcript.workspace_recovery` | Optional legacy workspace metadata recovery                                |
| `transcript.legacy_read`        | Existing SDK history lookup, when needed                                   |
| `transcript.projection`         | Restore messages from the selected event prefix or legacy messages         |
| `transcript.serialize`          | Express's existing JSON serialization, before entering `send`              |
| `transcript.response_write`     | Express send processing through response finish/close                      |

The durable variant remains with its existing EventStore owner and does not claim
the ordinary reader's internal phase breakdown. `events_read` combines SQL and row
decoding; a slow result there justifies a narrower observation in that owner later.

Response observation temporarily wraps the existing `send` method for that response
and restores it before delegation. It does not stringify, buffer or copy the body a
second time. Write completion records Content-Length when supplied, a fixed encoding
classification and aborted/completed outcome. ETag and any send-time body handling
are included in `response_write`; a long write is not proof of network latency alone.
Server finish is not browser parsing/rendering time or proof the user received it.

Early disconnect ends the request observation without cancelling another caller's
shared read. Telemetry failure cannot replace the original operation result, skip
cleanup or change errors. The common bounded observation helper is used by transcript,
MCP and local Codex phases. Upstream error messages and content are never recorded.

## Follow-up comparison

After an explicitly authorized deployment, compare cold sends separately from warm
continuations. Inspect fetch versus local resolution and login/executable/native
connection phases, then identify the source responsible for MCP handshake tails.
For large histories, compare age, event count, response bytes and read/projection/
serialization/write durations. A sequential reopen cannot benefit from in-flight
coalescing. Prefer evidence from these phases before adding broader caches, changing
freshness contracts, moving connector waits, or redesigning transcript loading.
