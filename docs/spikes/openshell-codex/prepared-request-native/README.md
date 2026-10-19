# Prepared Responses request source

This source bundle extends the inspected Codex `rust-v0.160.0` pin
`a956835d020762cb2b570053af06f643a11c0ecc`. It is an implementation foundation,
not an installed runtime or a qualified Symposium route. It uses the existing
Codex HTTP, Responses API and StateRuntime owners. No provider session system,
account profile, runtime selection or deployment is added.

## Current composed source: 49 patches

The 49 ordered patches reconstruct native tree
`58f83c08f2df67c830fe6cf1ee435a03a8b3f6f0` (local source `9710104802944987fbd017baf39706c535665922`).
The current source adds the actual ordinary child-approval consumer to the retained
immutable-request foundation. It reuses only a genuine fresh user approval from
the same still-active initial invocation. The original runtime lifetime flag is
never reopened, and returning/yielding from that invocation closes reuse. The
existing physical sandbox and denied-read restrictions remain enforced.

Actual hooks and reviewer contributors run through their existing owners and keep
their precedence. Only the exact default User route without a fresh-review
requirement and with zero matching hooks can attempt reuse. The consumer holds
the existing provider-policy, Session, task, settings, policy-manager and
selected-environment owners while it checks current identity and the original
runtime flag. An unsuccessful attempt revalidates the retained child context
before any manual prompt. Explicit AskUser, hook decisions, Guardian review,
unsupported physical contexts and changed authority keep their existing behavior
or refuse. Inherited approval is private and never recorded as a new User grant.

The additional source includes full actual-manager regressions for immediate
reuse, an already-returned initial invocation, post-attempt context drift and
matching decline/error/async/deny hooks. A narrowly gated test-only scheduler
makes the post-attempt drift deterministic; it is absent from production. The
original denied-read regression and the explicitly approved Guardian fixture
remain intact. Separate fixture corrections establish a Tokio test boundary and
configure the hook fixture before its actual ordinary setup.

All ordered patches and their checksums must reconstruct the exact source tree
recorded in `source-evidence.json`. Root and the original independent reviewer
reviewed each added source stage. Local checks are source reconstruction and
scoped formatting only; no local Rust compilation or test execution is claimed.
The existing Linux/Mac workflow is the compilation and fixture gate for this new
tree, with no extra CI job or disabled coverage.

The preceding 31-patch run `39146186841` failed on both platforms: Linux ran
5,764 tests (5,761 passed, 3 failed, 11 skipped); Mac ran 5,542 (5,539 passed,
3 failed, 27 skipped). Platform counts overlap and must not be added. Both jobs
completed with failure; neither is qualification of the new source. New-source
CI results remain pending until recorded against its actual application head.

This repairs ordinary shell permission compatibility. It creates no prepared
Responses admission, request preparation RPC, provider send, application joining,
installed runtime support or configured account qualification. Those remaining
contracts below still apply.

The 46-patch run `39168656856` reached the fixture command, but Linux failed
while compiling the test binary: the new routing-test module omitted `EventMsg`
and used the structured `CodexErr::TurnAborted` constant as a pattern. No native
fixtures executed on either platform. The 47th patch changes only that test module: it imports the
actual protocol types and checks `CodexErr.details()` for the same `TurnAborted`
semantic error. Production code, fixture expectations, all earlier patches and
workflow coverage are unchanged. macOS failed test compilation for the same three errors. This correction has scoped formatting and source proof;
new-source compilation and fixture execution remain CI work.

The 47-patch run `39172947853` also failed test compilation on both platforms,
before any fixtures executed. Its sole diagnostic was `E0308`: the exact cwd
assertion compared public `LegacyAppPathString` with `AbsolutePathBuf`. Patch 48
converts the expected cwd using the ordinary approval event owner's public path
representation. It preserves exact path equality, all other assertions and
production source. Root and the existing independent reviewer inspected the
complete routing-test module and actual type/owner contracts; scoped formatting
passes. Compilation and fixture execution for this new tree remain CI work.

The 48-patch run `39177320936` executed Linux native fixtures: 5,821 ran,
5,815 passed, six failed and 11 skipped. The six new direct-manager tests stopped
at a real terminal `SandboxDenied` result before checking their retained approval,
hook, admission and nonleak invariants. macOS was canceled by GitHub at the
90-minute job limit after 4,405 of 5,599 selected results were observed: 4,399
passes and the same six failures. It has no final suite summary or completed
Mac pass count. Platform counts overlap.

Patch 49 retains the complete actual manager result and recognizes only its
specific terminal-denial variant; other errors and join failures remain fatal.
It checks the actual exit status and process-store absence before cleanup, then
uses the original output bytes for marker/nonleak checks. Yielded cases still
require a real live successful result. It creates no tool output or lifetime
fields. All approval/hook/private admission/secret assertions and the original
polling owner remain. Production source is unchanged. The existing independent
reviewer inspected all three test files and callers; scoped formatting passes.
No local Rust compilation or execution occurred; new-source CI remains required.
The existing macOS job budget increases to 120 minutes because cold setup and
compilation used about 59 minutes before fixtures. Linux remains at 90 minutes;
package coverage, one test thread, zero retries and failure propagation remain.

## Immutable request foundation

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
`codex-http-client`, `codex-state` and the affected `codex-guardian-reviewer`
extension together. The earlier three-crate workflow
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

## Historical 31-patch approval checkpoint

At this historical checkpoint, the ordered bundle contained 31 patches. The original twenty-six checksums
are unchanged. Patches 21–23 retain typed extension routing, fresh user provenance
from the actual approval owner, and original configuration/policy plus actual
restricted-launch bindings. Root and an independent reviewer inspected each
stage; the corrected bundle reconstructs tree
`fb843b07af4fb2d3ba6517811ff2d88bae1d5fcd`.

The production policy flags, hooks, contributors and permission guards remain.
The original parent denied-read fixture remains unchanged. Only an actual fresh user approval can produce the sealed evidence;
cached/session, Hook and Guardian approvals cannot. Actual initial-call lifetime
tests use `exec_command_inner` and its real stored flag, including yield,
future drop, process failure and retained polling. Configuration and manager-policy
drift tests use their original owners. These new Rust tests have not run.

This source has no child consumer or final Session admission CAS. It now retains
same-request review routing and hook observations, but cannot reuse parent
approval yet. The existing
native CI job now includes the changed Guardian reviewer crate on both platforms;
its shell-recording coverage passed 19 cases locally, which verifies package
selection only. The 23-patch CI run `39125280789` failed on both platforms during helper
compilation: a new check accessed nonexistent `EnvironmentConfig.permissions`.
No native fixtures ran, so that run has no native pass/fail/skip counts.

Patch 24 uses the selected `TurnEnvironment.permission_profile()` owner and
requires Restricted networking in selected, requested, canonical and transformed
profiles. Existing proxy, managed-network, snapshot, grant and sandbox exclusions
remain. A selected-environment regression and four-position matrix were authored
first; only scoped formatting and source checks ran locally. Root and independent
source review missed the original field error; neither review established compile
qualification. Compilation and fixture qualification of the correction remain
pending exact-source CI for that historical composition. The C2 observations
are now included by patch 28, described below.
The twenty-fifth patch is the exact explicitly approved Guardian terminal-test
correction (18 October, patch SHA
`389b5db30b7b2ccd64af0fc5f928d71bf0abe30d5b10bb1d883880e325d19a0e`).
The unchanged-restrictions positive retains six offline requests, two actual
current-turn Guardian assessments, original command identity and a real denied
file nonleak. A separate changed-deny/cwd case requires the existing refusal
before stdin, Guardian or child effects, with both secrets unchanged. Only two
test files change; the entire production Core tree is byte-identical before and
after this patch. The original assertion exception is explicitly approved; no
other assertion or guard waiver is implied. These tests have not run on the
composed tree; exact-source CI remains required.

The twenty-sixth patch fixes a second compiler error exposed by native run
`39132277931`: both helper builds reject a borrow of `snapshot_credential_context`
after its original ownership move (E0382). No native fixtures started, so that run
has no test pass/fail/skip counts. The correction retains only an immutable
presence boolean before the move and uses it in the original exclusion. The
credential value still moves once through its unchanged owner; no credentials
are cloned or recreated, and no guard or assertion changes. Root and independent
source review missed this ownership error too; corrected compilation and fixture
execution remain exact-source CI requirements.

Run `39140112157` on the 26-patch tree built the standalone helpers on both
platforms, then failed to compile the Core tests: five assertions in the new
persistent-terminal refusal test had an ambiguous `assert_eq` macro (E0659).
No native fixtures ran; no native pass/fail/skip counts are available. Patch 27
adds the explicit `pretty_assertions::assert_eq` import used by its enclosing
module. Removing that one import restores the entire approved test file
byte-for-byte. The original 26 patch checksums, including the approved Guardian
correction, remain unchanged.

Patches 28–31 retain the existing review owner's actual selected configuration
and hook observations, add read-only cached environment observations, retain the
exact policy Arc used by the existing Unix evaluation, and fence intercepted
manual approvals against their selected context. Preflight precedes callbacks;
every UserPrompt result requires the configuration actually used by the one
review-routing call before resolution or telemetry. Legacy reviewer APIs and
decisive Hook/Guardian outcomes retain their original behavior. Actual-owner
policy, environment, malformed-input and delayed-manual regressions are retained.

Root and an independent reviewer inspected these stages, and the complete ordered
bundle reconstructs the pinned tree. Only scoped formatting and source checks
ran locally; no compilation or Rust test success is claimed for the combined
source. The original environment-observation temporary test-first artifacts were
lost; reconstructed Git bytes match all three hashes retained in the conversation,
but do not establish original artifact custody or an executed RED. Other staged
test-first artifacts remain retained separately. Physical child binding, locked
one-use consumption and inherited parent approval remain unimplemented. These
shell context checks do not establish cross-owner prepared-request authority.

This ordinary shell compatibility work creates no prepared Responses capability,
HTTP send, provider session, application joining or runtime adoption authority.

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

### Conservative Linux literal glob expansion

The twentieth patch extends the existing launch-time bwrap glob expander to
resolved UTF-8 literal regular files and verified clean missing paths. Every
existing prefix must be a real directory; all symlink components, directories,
special files, ambiguous literal syntax and unexpected metadata errors refuse.
This does not reserve future names or add filesystem atomicity. The original
wildcard scan, logical/canonical match handling, depth behavior, per-read matcher,
approval assertions and sandbox guards remain unchanged. All expansions share
the existing 8,192-path deduplicated bound.

Nine new Linux owner cases are retained but have not run locally on macOS. The
existing Linux CI job now includes codex-linux-sandbox alongside the original
four crates; no new job or upstream diagnostic comparison is added. The preceding
run 39100230330 recorded Linux 5,471 passes / 2 failures / 8 skips, with the skill
completion correction passing in 0.502 seconds. Both remaining Linux failures
were sandbox construction failures for literal deny globs. Removing that
construction incompatibility may expose further approval failures.

The preceding Mac job reached its 90-minute limit with 4,478 recorded passes,
5,482 selected tests and 27 announced skips. Its retained log has no final summary
or JUnit; its remaining fixture outcomes and cancellation cause are unknown.
The new exact source still requires CI. Neither source reconstruction nor these
partial results qualify an installed runtime.
