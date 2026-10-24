# OpenShell delivery and warm-pool efficiency

This follow-up addresses live event delivery, provider-neutral warm-pool work and
unsupported connection tool discovery. Executable reuse for Local/OpenShell seats
and the independent startup overlaps remain with their existing owners (#1122 and
#1124). This change does not alter executable custody or the one-use knowledge
admission receipt.

## Observed delay

An existing OpenShell API-account turn on release `3517978b` took 16.782s from
server receipt to provider dispatch and 19.663s to the first persisted text delta.
The first response had 17 deltas over 997ms, so the provider/server path already
produced progressive text. The server retried growing delivery backlogs while the
client cursor remained at the original user message, followed by reconnect.
Server timestamps do not establish the exact device receive/render delay.

Before dispatch, the trace recorded 18 repository credential checks and 82
keychain reads. These are nested measurements, not additive elapsed time. They
remain authority checks; this PR does not cache credentials or remove their
revocation/provider fences. OpenShell repository preparation omits one redundant
preliminary readiness call: canonical key resolution already verifies readiness
inside its credential owner. The fresh post-resolution readiness check remains.
Failure to resolve through the selected controller never falls back to a raw key;
post-resolution gateway drift still rejects the preparation proof.

## Immediate durable prefixes

The applied-cursor client must see a durable predecessor before its successor.
Internal events, including private ordinary reply provenance, may be persisted
without an individual live broadcast. Previously a later text delta could arrive
first and sit in the client's buffer until the five-second periodic retry supplied
that predecessor.

ConnectionRegistry now fills that gap immediately through the canonical stored
event projection, including its existing private-data redaction. A separate
per-connection/session forwarded watermark avoids rereading the prefix on every
delta while HTTP acknowledgements are in flight. It never advances the applied
cursor. Reconnect/snapshot confirmation resets its baseline; failed sends do not
advance it. Existing snapshot fences, exact contiguous ACK validation and bounded
50-event catch-up remain. Contiguous live output does not wait behind an HTTP ACK.

Offline tests use the actual AppliedDelivery implementation to demonstrate the
previous stall and immediate application after repair. They cover withheld ACKs,
bounded continuation and failed transport writes. This fixes that reproduced
mechanism; it is not proof that every device-side cause of the observed stall is
resolved.

## Warm only work that can be reused

The old adapter prepared, froze and uploaded knowledge at
`/sandbox/pool-knowledge`. Claim did not consume that copy: it selected and uploaded
fresh task content, then normal command admission reconciled knowledge. Neutral
warming now omits the unused knowledge selection/freeze/upload. The selected image,
policy, resource limits, exact origin and physical Ready checks remain. A final
recipe check prevents publication as Ready if configuration changes during create.

Claim still verifies fresh knowledge before task upload or provider attachment.
An unavailable publisher therefore permits a neutral spare but rejects claim
before those effects. Existing copies, owned resources and uncertainty records
are retained; no cleanup or activation is performed.

Sandbox identity and provider inventory are independent read operations and now
overlap. The native adapter returns its final observed physical/provider state;
the pool validates that exact result rather than fetching the same state again.
Adapters returning no observation retain the extra inspection. Substituted physical
IDs, wrong providers and failed final observations still leave ownership uncertain.

For an already Ready spare with no polling, the claim path previously performed
five inspections, each with two serial CLI reads. It now performs four inspections,
each with overlapping reads: eight native read calls instead of ten, and four
inspection read stages instead of ten serial read stages. Upload, attachment and
ordinary runtime admission still have their own costs. These are source/offline
operation counts, not measured end-to-end latency gains. Pool support remains
limited to its existing qualified adapter; no new runtime class is enrolled.

## Truthful connection discovery

ConnectionWebSocket is a service-tool transport (for example Home Assistant trace
queries), separate from Mitzo's SSE/HTTP chat transport. Owned runtimes currently
reject it and HomeAssistantDashboard before requesting approval because their
multi-frame transport lacks the final runtime-authority fence. They are omitted
from owned tool discovery and corresponding usage guidance; stale/forged calls
remain denied. Supported legacy runtimes retain their existing tools. Home
Assistant guidance also prefers scoped entities and bounded history over an
unfiltered state response that can exceed the connection limit.

## Validation and adoption

Focused regressions use mocked subprocesses/services and local protocol fixtures.
No model, live sandbox, production credentials or staging are used. Required broad
CI and trusted review remain merge gates. Production activation and real pool
enabling require a separate explicit action. Warm pools remain disabled on the
investigated host; no real performance gain or device acceptance is claimed here.

There are no rendered component, layout, theme or design-ledger changes. Shared
SSE/WS delivery is exercised below the UI through the actual client ordering
implementation and store regression suite. No visual redesign is introduced.
