# Prepared Responses request source

This source bundle extends the inspected Codex `rust-v0.160.0` pin
`a956835d020762cb2b570053af06f643a11c0ecc`. It is an implementation foundation,
not an installed runtime or a qualified Symposium route. It uses the existing
Codex HTTP, Responses API and StateRuntime owners. No provider session system,
account profile, runtime selection or deployment is added.

The patches retain these source primitives:

- A private immutable public Responses HTTP body with a documented input-count
  projection and an explicit output reservation. The caller-supplied numeric
  output bound and a raw token count do not establish selected-account capacity.
  Unsupported internal/stateful
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
  not recreate a handoff; late provider receipts remain evidence only. The live
  consumption handle is bound to its originating StateRuntime pool, so an
  independently opened runtime cannot use that handle.
- A private helper that freezes the supported public subset of an already-finalized
  ordinary body. It refuses populated native metadata and unresolved request
  contributors without invoking them. Its successful fixtures are a supported-body
  subset; the actual ordinary client currently supplies metadata that refuses.
  The helper has no production caller and does not capture pre-session sources.
- Distinct sampling records within one ordinary command, with one consumed root,
  one successor per predecessor and one original native turn acknowledgement.
  Legacy command tombstones retain their original conservative behavior.
  Continuations retain independent bytes/counts/receipts and cannot change the
  command model or settings. Acceptance and acknowledgement do not prove completion.
- The actual ordinary project-document reader now streams configured instruction
  prefixes. Its existing hierarchy, trust, symlink and rendering rules remain.
  Physical reads use bounded 1 MiB chunks; skipped tail errors and whole-file size
  refusal no longer apply once overflow is observed. This is ordinary prefix
  loading, not immutable source capture or the application artifact byte fence.
- Ordinary role descriptions now separate source loading from pure rendering,
  while image-tool eligibility is retained at its original registration point.
  Callback, consent, cache and tool registration ordering remains ordinary.
  These narrow retained inputs do not establish a complete pure tool inventory.
- The frozen public-body validator accepts supported deferred function, custom
  text/grammar and namespace tool shapes without changing their JSON or order.
  Conditional shapes outside that subset refuse. Actual ordinary populated
  metadata still refuses, and tool shape support grants no model/account authority.

`source-evidence.json` pins the upstream tree, ordered patches, patch checksums
and resulting source tree. To reconstruct the exact source without building or
starting a runtime, supply an absolute local checkout containing the public pin:

```sh
node qualify-source.mjs /absolute/path/to/public-codex-source
```

The verifier uses a temporary source-only checkout and removes it afterward. It
never reads application configuration, selects credentials or invokes a model.
The native CI workflow is configured to reconstruct and test this source against
fixture transports and temporary databases. It includes `codex-core` (including
the formatter and real ordinary HTTP/WebSocket owners), `codex-api`,
`codex-http-client` and `codex-state` together. The earlier three-crate workflow
did not qualify the formatter or its ordinary request owners. Historical foundation
results and current composed-source results are recorded separately; an older
pass count cannot qualify a newer tree. Full fixture logs and JUnit results retain
skipped/filtered counts and run without automatic test retries.

The eighteenth patch updates only the remote-environment test server for the real
`fs/open` / `fs/readBlock` / `fs/close` instruction-reader protocol, retaining its
original assertions. Corrected exact-source CI now reaches the complete fixture
phase on both platforms, but still fails; see the recorded results below. The prior
17-patch CI run `39076917374` reported green jobs while `tee` hid upstream test
failures: Linux had 5,088 passes, 385 failures and 8 skips; Mac had 5,173 passes,
309 failures and 27 skips. Those jobs do not qualify the source. Their original
logs and counts are retained. CI now explicitly propagates pipeline failures,
builds the actual required runtime helpers and supplies pinned upstream test
prerequisites. These changes do not establish that every native failure is fixed.

The application changes in `server/collaboration-context-compiler.ts`,
`server/collaboration-review-owner.ts` and the existing EventStore retain a
private native witness behind a public total-count assessment. They preserve the
original review operation across incomplete retries, concurrency and restart.
Public snapshots and replay carry no native preparation or provider identities.
Historical additive assessments remain readable; they confer no native dispatch
authority. Production `app.ts` still does not install the optional joining port.

The existing enrolled OpenAI account owner now provides a private immutable
credential observation and renews existing credential resolution. It retains the
original account IDs, managed credential custody and Connections gate. Callback
renewal detects drift; it does not order native consumption, supply model limits
or establish a selected dispatch client. This evidence must remain server-private.

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
dependencies. The selected Stop contract is best-effort after the native attempt
commits: a winning pre-attempt close prevents send; a committed attempt may already
have reached the provider, remains uncertain if acceptance is unknown, and cannot
be replayed. The state primitive supports that decision; ordinary Stop wiring is
still part of the pending dispatch integration.
The sampling chain provides retained request identity for tool continuations; the
actual ordinary tool loop must still authorize and prepare each request. Pool
binding prevents transferring a live handle; it does not establish custody of a
stale database copy made before consumption. The actual selected admission owner must refuse lost/replaced storage.
Likewise, the raw frozen transport API does not itself consume an attempt or bind
the selected account/client. These source primitives cannot be used as a complete
ordinary dispatch protocol.

Other source/access/account/route authority changes still need ordering against
native consumption; consumable admission remains unavailable for those changes
until that ordering is proved. Live calls, activation and deployment require their
separate user authorizations described in the Symposium handover.

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

### Verified V8 build dependency preparation

Run39083668664 on native tree7407c99d failed on both platforms before native test execution: building the real code-mode helper enabled V8, and standalone Cargo tried unavailable Deno archives. Pinned upstream already supplies the supported `ptrcomp_sandbox_release` archive and its matching Rust bindings through `scripts/codex_package/v8.py`. CI now calls that unchanged owner with the reconstructed source root, verifies its source-pinned manifest and both artifact hashes, and publishes both Cargo paths together. It refuses unsupported/ambiguous hosts, verifier failure and a source-build bypass. The native source tree and eighteen patches are unchanged.

Sixteen recorded workflow regressions and twelve unchanged upstream offline dependency-helper tests pass. They are build-preparation evidence and are not added to native crate counts. Run `39087651210` on application source `542400d2` completed verified artifact preparation and helper builds on both platforms, then failed the native fixture phase. Linux executed 5,473 tests: 5,470 passed, 3 failed and 8 additional tests were skipped. Mac executed 5,482 tests: 5,479 passed, 3 failed and 27 additional tests were skipped. These platform counts overlap and must not be added. Native formatting was skipped after the fixture failures. Full logs, JUnit, source reconstruction and verified V8 artifact receipts were retained by that run. Historical masked failures remain retained above.

The failing test names match across platforms: the skill declared-permissions case, persistent-terminal current-turn Guardian review, and parent approval with denied reads. Their failure causes differ. Linux refuses two cases while loading AGENTS.md because the sandbox helper cannot expand the fixture's literal deny glob. Mac reaches the approval flow: the persistent terminal refuses changed filesystem restrictions, and the parent-approval case receives an unexpected child approval. The skill case times out on both platforms. Read-only source inspection identifies a consumed completion event followed by a second wait in that fixture, but static inspection does not replace an executed upstream control. The relevant permission/helper/fixture owners are unchanged from pinned upstream; reachable integration changes still require comparison. No assertion, sandbox fence or skip guard has been relaxed. This run does not qualify the composed source or any installed runtime.

### Public schema and ordinary metadata audit, 18 October

The official [Responses create reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create)
and [input-count reference](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count)
were fetched as Markdown on 18 October. Their SHA256s were respectively
`a5a6eb5d7f43fde87963d91314c4debb82c2ee2551965f8c7e070e64b3e569ef` and
`af420bceb28be322e85b9609f70632c2f1756101be0d443992ce11156627c041`.
The public schemas document conditional shapes beyond this validator's subset:
reasoning context and max effort, configuration updates and original image detail.
Create also documents access programs; count does not accept that parameter.
Current implementation refusals must not be described as universal public API
limitations, and adding a shape still requires exact count-projection coverage.

Neither reference documents native client metadata or internal item passthrough.
The ordinary provider policy includes internal metadata for the official HTTPS
API host. Disabling the configuration flag does not override that host policy;
other routes with the flag disabled still produce client identities and ancestry.
The native item type explicitly describes passthrough into underlying chat
messages. Public object metadata does not establish an equivalent representation.
Populated native fields remain refused; they are not dropped or silently moved.

Final HTTP capture must include the existing owner's late guardian and auth
selection, normalization, contributors and tool-result metadata bounding before
serialization. Contributors may create effectful response interceptors. Freezing
an earlier builder result, invoking those contributors during pure preparation,
or claiming a fresh-session tool inventory from an existing session's discovery
snapshot does not close this boundary. No public-success policy, pure pre-session
capture, selected-account capacity or consumable dispatch is established by this
audit.

### Skill fixture completion correction

The nineteenth patch changes only the skill fixture's redundant second wait for
`TurnComplete`. Its existing approval helper consumes that event before returning
`None`; the unchanged `approval.is_none()` assertion already establishes that
completion was observed. The second wait is replaced with an explanatory comment.
All six assertions, helper behavior, configuration, skip guards, output checks and
filesystem checks remain byte-identical. Independent source review found no
counterexample in this single-turn fixture. No native production source changes.

Run `39094032703` on the preceding eighteen-patch tree repeated the per-platform
failures and counts of `39087651210`: Linux 5,470 passed / 3 failed / 8 skipped;
Mac 5,479 passed / 3 failed / 27 skipped. The skill timeout is an executed failing
regression; attribution to the duplicate wait is source analysis, not dynamic
isolation. The nineteenth-patch tree requires new exact-source CI. The Linux
literal-glob sandbox construction and Mac permission/child-approval failures
remain unresolved. No permission rule, assertion or guard is relaxed, and no
runtime qualification or upstream comparison is inferred.
