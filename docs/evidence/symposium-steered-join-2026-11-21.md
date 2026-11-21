# Reviewed joining after active-turn corrections

S3 (`42cb2d182d3c18c2`), findings 16 and 19. Base: `9fa5d6fa6`.

The new application fixture first failed at the authenticated durable transcript
read with HTTP 500 after the real SDK steering owner recorded its exact provider
acknowledgement. The source validator rejected the user correction between the
assistant's start and end. After the fix, the same fixture captures all public
text and passes the real review and joining owners with synthetic external
account/repository/provider boundaries. Joining starts no model turn.

The validator qualifies only a user correction with the ordinary `steering`
projection and a target matching the retained reply/dispatch command in the
same session. Legacy histories without those markers use the preceding
non-correction command. Queued prompts do not replace a retained active owner;
ambiguous or malformed ownership never falls back to adjacency.
Unqualified user overlap, stale/foreign/assistant/missing targets,
missing state, duplicate IDs and overlapping assistant starts remain refused.
Every read fence repeats qualification; changing a correction target invalidates
an already opened source. No private receipt content is needed or exposed.

Completed-message sequence remains the ordering and boundary anchor. Newly
supported overlapping messages carry the assistant's `startedAtSequence` and the
operator correction's `steersMessageId`; these public fields are included in the
existing source hashes and byte budget. They describe chronology and intent,
not a claim that the provider accepted a correction. Previously qualified
non-overlapping source messages retain their serialization and pins. Streaming
capture still freezes the completed prefix before the earliest unfinished reply.

Unqualified overlap now returns `source_history_overlap_invalid` and a fixed
explanation through durable HTTP reads, reviewed joining and specialist tool
responses. Internal transcript diagnostic correlation and original causes remain
retained; unexpected failures keep the existing failure path.

Focused checks cover the SDK owner → authenticated typed reader → review → fresh
join, refusal through the real review consumer, one-message pagination, repeated
corrections, source mutation, corruption rejection, byte bounds and tool/HTTP
diagnostics. These are offline source checks, not deployment or live acceptance.

Validation: 194 tests across eight focused suites pass with one worker and a
1 GiB Node heap. Protocol TypeScript compilation, changed-file ESLint, formatting,
diff whitespace and regenerated reviewed source-artifact checks pass. Local
read-only review identified the queued-command case; it was reproduced failing,
fixed, and verified in a targeted follow-up with no new concrete blockers.

## Original attempts and remaining evidence

The saved November 16 findings report establishes that Terra request
`ea6c312d-1d33-438e-94c9-5f0263e372bc` failed in the interleaving guard before
reservation. It explicitly says the specific retained events were not enumerated.
This fixture proves the supported steering failure and repair; it does not prove
every historical overlap in that original request has this qualified shape.

Manual Alice finding 19 remains **unresolved**. The saved report's sequence 725
screenshot contains selection, not a refusal, original request ID or receipt.
On November 21 the cited `main-9fb726d2869c` release and its
`server.2026-11-16.220614.log` were absent from the local release directory; the
other eight retained release log directories had no November 16 files. The
current feature lead confirmed no additional request identity was available;
their original-discussion read failed with diagnostic
`e9fe99b5-5596-4126-ab70-f5cb6f573891`. No new
seat or replacement attempt was created to substitute for that evidence.

Next action: correlate Alice's original manual review/join request and response
using retained request/trace evidence. Do not attribute Terra's cause to Alice.
The slice remains open until this criterion is resolved or explicitly revised.
CI, exact-head Centaur approval, merge and activation are separate evidence.
