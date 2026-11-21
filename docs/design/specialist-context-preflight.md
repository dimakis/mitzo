# Specialist context preflight

P1 implementation from accepted main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`.
This ordinary contributor has no canonical Telos assignment. Scope reference:
`174b3b7c9de2b08b`, under feature `0e7adf5e27292950`.

## Failure and boundary

Previously a 36,000-byte assignment under a 32,000-byte policy reserved a call,
prepared a repository and compiled a joining review before the size check. The
catch then labelled the refusal uncertain. Purpose copied the first 4,000
characters of the assignment; joining brief copied the whole assignment again.
A long attributed `reviewOf` result was appended only after workspace preparation.

The service now compiles the selected completed public prefix with the existing
source/compiler owners before `receipts.reserve`, repository preview/preparation,
joining or dispatch. The exact assignment appears in the explicit requested reply;
generated purpose identifies the specialist role, and the joining brief points to
that reply. Selected source content is never searched for duplicates or edited.

The canonical byte envelope is UTF-8 JSON of
`{ context: snapshotMaterial(draft), text }`. Context includes source identity,
boundary, purpose, joining brief, every selected message with attribution and
hashes, every exact artifact revision/hash and retained Base64 contents, and
summary. Text includes the assignment plus the complete attributed prior
contribution and its `reviewOf` request ID. JSON escapes and framing count.
The eight component sizes sum exactly to the total; individual message/artifact
sizes help the caller explicitly narrow the selected evidence. Reports contain
sizes and selected IDs, not copied content.

The approved byte ceiling remains unchanged (default **32,000**, not 32 KiB).
Below and exactly equal pass; above refuses. No truncation, limit inflation,
profile redesign or amendment protocol is introduced. Snapshot review bookkeeping
(capacity assessment, creation timestamp and review IDs) is not selected material.
This is a selected-context budget, not total provider input or token occupancy:
ordinary instructions, tools, shared-discussion transport framing and the runtime's
own capacity checks remain with their existing owners.

## Receipt and consumer contract

`ConsultationRecord.contextEnvelope` is optional for historical compatibility.
New requests atomically retain the compiled draft and exact reply text in the initial
reservation before preparation, using the optional named admission argument.
The eventual approved joining snapshot must equal the preflight material. Recovery
retains that envelope and verifies the original attributed contribution rather than
substituting a later result. Existing source/dispatch authorization still renews.
Historical reviews/messages retain their original brief and dispatch encoding.

`SymposiumConsult` exposes a typed `context_limit`, `stage: context_preflight`,
the exact byte report and an actionable narrowing instruction. A fresh refusal
has `outcome: not_started` and a settled callback outcome: there is no consultation
receipt, repository preparation, participant allocation or native dispatch to
recover. A historical request uses `outcome: existing_request`; earlier effects
and uncertainty are not cleared. Expected refusals are logged with stage, request,
session and numeric breakdown. Unexpected errors retain existing diagnostics.

S8 owns allowance accounting. The agreed integration point is immediately before
`receipts.reserve`, after route selection. P1 does not change allowance state or
refund dispatched/uncertain work. The additive envelope field and service hunks
must be preserved when integrating S8's mode/admission changes. The seventh
`reserve` argument is a named admission object; S8 adds `modelPolicyRevision`
alongside P1's `contextEnvelope`.

## Related contracts

- #1424 at `d88b662f20bd77cf9f06e6f2b04c6ee72886bf63` defines typed native context
  observations, token/usage accounting, source contributions and query identity.
- #1431 at `18afc8a0a0d196687df50fd3301a454bb1e9e28d` persists those observations
  and fences refresh/attachment lifecycles. It depends on #1424.
- Neither supplies this pre-reservation specialist envelope. P1 has no dependency
  on either branch and does not publish its byte report as a native measurement.
- S3 #1434 at `a5b272aeeb0908abb564d9e0ff1d50d2cd705050` is a source-validation
  candidate. P1 uses the existing compiler without altering provenance or source
  qualification, and does not require that candidate to merge first.

## Evidence and remaining gates

The initial real-application regression failed with an uncertain reserved receipt.
Pure tests cover 31,999 / 32,000 / 32,001 bytes, multibyte text, JSON escaping,
long attributed review text, artifact/message pins and exact component totals.
Application tests exercise the actual source compiler, SQLite receipts, workspace
owners, native adapter and tool consumer with external provider execution replaced.
They prove zero reservation/preview/preparation for oversize requests, successful
delivery of exact UTF-8 artifact content and an 18 KB assignment without redundant
brief copies, retained recovery, Stop and policy fences. A separate application
fixture isolates long-review tests from the real eight-workspace preparation cap.

Source publication remains a draft candidate. Hosted full build/CI, exact-current-
head Centaur review and integrated landing checks remain required. No browser/mobile
UI changed; rendering and live model/runtime acceptance are not claimed. No live
model calls, merge, deployment or staging activation are authorized or performed.
