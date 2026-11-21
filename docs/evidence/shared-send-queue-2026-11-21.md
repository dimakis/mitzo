# Shared Send and Queue candidate

Base: main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`.
Branch: `fix/shared-send-queue-s2`. Ordinary contributor for S2; Telos linking is deferred.

## Boundary and existing work

Preserve accepted #1374 draft revision fences, shared message actions, exact request recovery,
Stop and steering owners. Reuse the explicit refusal behavior from unmerged #1379 commit
`7350122c6c7af7c633fad0f716c940879b92a9df`, adapted to the current hook rather than replaying
the old branch or its unrelated sharing/source changes. #1379 is closed without merging.

Inspected open draft #1406 at `12e1a1528368620f691198a5be12e73546cddeee`, branch
`feat/symposium-all-local-accounts`. Its repository diagnostics and retained consultation
tap belong to specialist consultation handling. This candidate is a separate PR against
main, with no prerequisite on #1406 and no changes to that branch or its owner.

S6 agreed to preserve the optional `ChatInput.onQueue` callback and primary handler lines
while it changes composer layout. S5 reserved trusted origin additions to server messaging;
this candidate leaves those server interfaces unchanged. S7's status implementation is
untouched; this candidate only feeds notice/busy state into the existing ChatStatusMessage.
The attempted S7 interface message and initial lead message expired before approval/delivery.

## Behavior

Readiness observation no longer owns the send mutex. One explicit press can claim a
submission while readiness is loading, await its selected audience, retain the request,
and enter the existing admission consumer. Repeated taps cannot create another delivery.
Known refusals remain blocked until refreshed. Recipient, membership, context, auth and
draft ownership checks still fence the original operation; changing recipients during
preflight never redirects the submitted text. Draft edits during preparation survive.

Queue has a separate composer callback and uses the ordinary durable admission path,
including its native FIFO, rather than the browser's unsent-draft queue. Shared Enter and
Ctrl/Cmd+Enter queue while running, preserving an explicit Enter-to-steer preference and
the lightning action. Acknowledgements distinguish preparing, queued, admitted and
uncertain delivery. They do not claim completed inference. Recovery observes the original
request and cannot create another command.

No public wire schema, server admission signature, transcript author identity, picker,
layout or stylesheet changes. No model calls, production or staging use.

## Validation

- Red: single press during loading returned false; blocked first press had no published
  refusal; pointer/touch/Enter/Ctrl+Enter never called a distinct shared Queue owner.
- Green: hook, real mounted shared composer and ChatInput tests cover delayed readiness,
  repeated taps, newer drafts, changed recipients, retained uncertain receipts, attachment
  consumption, auth loss, Stop and recovery ownership.
- Real application test uses HTTP, authorization, SQLite, ordinary admission and native
  FIFO with only the external native process substituted. A held first turn prevents the
  queued command from starting; observation/replay retains its command identity; completing
  the first turn starts the second once, with no steering or interrupt.
- Focused ESLint and reviewed-source artifact verification pass. Design checks: 109 passed,
  one existing skip. Local tests use one worker and a 1 GiB Node heap.
- Added offline browser regression through the actual shared fixture for one-press readiness,
  touch/keyboard Queue, distinct request identity and visible queue acknowledgement.
  Rendered verification is **blocked**, not passed: the initial task environment had no
  browser binaries; after installing Chromium inside this checkout, macOS denied
  `bootstrap_check_in ... MachPortRendezvousServer` during startup. No test body ran.
  WebKit download separately failed with a closed connection. No further browser launch
  was attempted after the macOS denial. Mobile/desktop screenshots and the full UI suite
  remain for an eligible host or CI.

Draft publication is not acceptance. Exact-head CI, applicable Centaur review, combined
integration checks with S6/S7, mobile/browser verification and any separately authorized
live gates remain before merge. No merge or deployment is authorized.

## Centaur follow-up from b59ae227

Review `CEN-5F2E296DC9CE` found that recovery cleanup could mutate the request list
while a new Send was flushing its retained identity. The new Send then failed the
whole-list durability check before dispatch, leaving an unacknowledged journal.
The delayed-disk regression reproduced this failure before the fix.

Send journal writes now serialize per draft through their flush and verification,
including writes from different composer owners. Readiness and receipt observation
remain concurrent. Freshness is checked after waiting for the preceding write and
again after persistence; failure still releases the queue and reaches the existing
structured diagnostic. Existing disk conflict detection is preserved.

The regression exercises both orderings (new retention first and old cleanup first),
exactly one dispatch, no persistence warning, retained acknowledgement, unchanged
draft text and the original request identity after cold storage reopen. The focused
hook/durability and mounted shared-composer checks pass (62 tests). No composer props, layout, server admission
or public schema changed in this follow-up. S6 owns combined validation with #1440
and #1442; it must recompute combined source pins.

CI inspection at baseline `b59ae22774fa167bbf53135369405679dc451f74` found failures
in unit shards 1/4 and 4/4 and offline layouts desktop Chromium 2/3, mobile Chromium
3/3 and mobile WebKit 4/4. Authenticated job-log reads returned transport failures;
annotations contain only exit code 1, so their causes remain unverified. No unchanged
CI rerun or browser launch was requested. Centaur's baseline remains available for
delta verification; exact-head CI and final review remain landing gates.
