# Prepared Responses request source

This source bundle extends the inspected Codex `rust-v0.160.0` pin
`a956835d020762cb2b570053af06f643a11c0ecc`. It is an implementation foundation,
not an installed runtime or a qualified Symposium route. It uses the existing
Codex HTTP, Responses API and StateRuntime owners. No provider session system,
account profile, runtime selection or deployment is added.

The patches implement three boundaries:

- A private immutable public Responses HTTP body with a documented input-count
  projection and an enforced output reservation. Unsupported internal/stateful
  bodies, mutable remote artifacts and model-affecting headers refuse.
- Explicit single-attempt HTTP execution retaining the existing destination and
  outbound route policy. Redirects, protocol retries, TLS fallback and hidden
  header/cookie rewriting are unavailable on this path.
- A durable native capability record in the existing state database. Exact
  operation retries compare the full frozen inputs; measurement is immutable;
  cross-process consumption succeeds once. Native turn admission and upstream
  response acceptance remain independent receipts. Consumed uncertainty never
  becomes a new dispatch.
- The retained formatter candidate, which shares pure Responses formatting with
  the ordinary ModelClient and preserves its HTTP/WebSocket normalization order.
  It still refuses public freezing when ordinary internal metadata or required
  output/truncation policy cannot be represented.
- The retained attempt-closure candidate, which arbitrates first transport
  attempt against durable closure with move-only live handoffs. Restart/read does
  not recreate a handoff; late provider receipts remain evidence only.

`source-evidence.json` pins the upstream tree, ordered patches, patch checksums
and resulting source tree. To reconstruct the exact source without building or
starting a runtime, supply an absolute local checkout containing the public pin:

```sh
node qualify-source.mjs /absolute/path/to/public-codex-source
```

The verifier uses a temporary source-only checkout and removes it afterward. It
never reads application configuration, selects credentials or invokes a model.
The native CI workflow separately reconstructs and tests this source against
fixture transports and temporary databases. It covers `codex-core` (including
the formatter and real ordinary HTTP/WebSocket owners), `codex-api`,
`codex-http-client` and `codex-state` together. The earlier three-crate workflow
did not qualify the formatter or its ordinary request owners.

The application changes in `server/collaboration-context-compiler.ts`,
`server/collaboration-review-owner.ts` and the existing EventStore retain a
private native witness behind a public total-count assessment. They preserve the
original review operation across incomplete retries, concurrency and restart.
Public snapshots and replay carry no native preparation or provider identities.
Historical additive assessments remain readable; they confer no native dispatch
authority. Production `app.ts` still does not install the optional joining port.

## Remaining integration

Native pure expansion must capture actual guidance, repository documents,
history, tools, schema, model, images and final transport transformations without
allocating a thread, writing history, invoking contributors with effects or
compacting. These patches deliberately do not accept a caller's host packet as
proof that this expansion happened.

The ordinary native `turn/start` owner must then validate current source, setup,
account, route, model and history authority; restore the exact retained body;
consume it once before send; and retain uncertainty and exact receipts through
Stop, reconnect and restart. A complete review context cannot be consumed as a
command. An explicit command requires a new complete prepared request that
includes that command. Selected account/model output limits and authoritative
capacity ceilings still need an application authority owner.

Until those owners are connected and offline composition tests pass, no account
or runtime combination is qualified. Authenticated application joining, reader
only delivery, frontend integration and target qualification remain subsequent
dependencies. Host revocation and native SQLite consumption still lack a shared
ordering owner; consumable admission remains unavailable until that ordering is
proved. Live calls, activation and deployment require their separate user
authorizations described in the Symposium handover.

Public body-schema handling of inline image/PDF bytes does not register artifact
sources or qualify saved files. The existing source reader and artifact-kind
refusals remain authoritative.

For review sizing, keep HTTP transport, durable state, immutable body/restore and
API count/send as separate dependent changes. The state patch retains its actual
SQLite regressions with its implementation; splitting those would obscure the
one-use guarantee.

The HTTP follow-up patches preserve typed TLS classification through boxed IO
errors and explicitly select the native backend in native fallback fixtures.
The redirect fixture also restores blocking mode on accepted sockets. Production
backend, trust and retry policies are unchanged; all original connection-count,
certificate and no-replay assertions remain.
