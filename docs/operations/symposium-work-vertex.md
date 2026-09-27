# Selected Work Vertex provisioning

Selected Work provisioning supplies identity and custody evidence for the separate
reviewed owned Claude runtime variant. Admission additionally requires its exact
image/native artifact tuple, endpointless provider policy, fresh installed-token
readiness, current account/model/host grants, and per-seat isolation. The older
Codex-only image cannot authorize Vertex seats. Offline physical startup and
continuation regressions are implemented; live inference acceptance remains a
separate gate. No existing account profile is migrated or altered.

An explicitly configured `personal.workProfiles` entry may select
`provider: anthropic-vertex`, an absolute `credentialRef` to a private owned
regular authorized-user ADC file, `expectedPrincipal`, `projectId`,
`region: global`, and exactly one model `claude-haiku-4-5@20251001`. Selection is
explicit; the undated catalog label is not automatically converted. The
selected project must match `quota_project_id` when present. The bootstrap
requires exactly one byte-pinned copy of the repository's
`infra/openshell/providers/vertex-seat-endpointless.yaml`; duplicate/broad
replacement profiles fail before gateway launch.

The existing bootstrap owner reads at most 64 KiB through an O_NOFOLLOW file
descriptor and uses the same in-memory snapshot for Google authentication,
verified email comparison, and gateway refresh material. It does not use
ambient gcloud, ADC discovery, service-account impersonation, API-key fallback,
or `--from-existing`/`--from-gcloud-adc`. No credential file is copied into the
gateway or workload. The real refresh material is transmitted to the retained
gateway through CLI secret environment inputs and is never placed in argv,
returned profiles, receipts, or errors. The operation can refresh OAuth access
tokens; it does not send inference requests.

The gateway creates a fresh provider, receives exact project/region config,
and returns a bounded census identifying name, ID, type, and workspace. Refresh
configuration and an initial rotation request must both be acknowledged before
publishing the account binding. Rotation acknowledgement is not proof that the
background refresh finished. Each retained-capability capture reads bounded
current refresh status between two exact provider censuses, requiring the
`oauth2_refresh_token` strategy, `refreshed` status, no recovery/failure, and a
stable installed credential expiry matching the refresh receipt with at least
60 seconds remaining. Status alone is insufficient because the upstream handler
persists refreshed state before installing the credential. Pending, uncertain,
expired or concurrently changing observations reject admission/dispatch. The initial token was authenticated from the
same selected snapshot. A failed/uncertain startup returns no binding; the existing
bootstrap stops its newly owned gateway. Do not retry or adopt that provider.
The code does not claim restart recovery.

`captureSymposiumWorkVertexProvider(gateway, providerId)` supplies an immutable,
same-process receipt containing the Google-verified principal and selected
account/project/region/model bound to the created provider identity. Only the
original gateway object with live custody can retrieve it; observing custody
loss removes the retained capability, including loss observed during readiness
queries. Readiness is never cached in that receipt: every capture performs a
fresh bounded observation using the original gateway's CLI and environment.
Serialized account metadata cannot reconstruct it. No parallel ledger or
scheduler is introduced.

## Proof limits

The pinned OpenShell CLI lists config **keys**, not config values or resolved
profile workspace. This increment proves acknowledged creation with exact
public intent, fresh identity census, and exclusive retained gateway custody;
it does not claim public-config readback. The owned production gate verifies the
resolved endpointless profile and exact provider association, while the fixed
native launcher verifies projected project/region and clears model/provider
overrides. The separate measured image supplies binary and filesystem evidence.
The supported refresh-status table has second precision; provider list JSON
supplies installed credential expiry and resource revision, checked before and
after status. These observations prove current gateway credential readiness,
not successful sandbox inference, model enablement, prediction IAM, or future
refresh success. No credential value is returned or logged.

Claude claims use fresh native session UUIDs and complete eligible same-seat
history as bounded untrusted user input, never native `--resume` or copied state.
Actual offline stream-json startup emits the expected dated Haiku model/session
receipt. Model mismatches and missing required model receipts fail before event
projection. Each message is buffered until its matching assistant ID/model
receipt; verified completed messages project incrementally across tool turns,
not as live unverified token deltas. Cancellation releases pending output.
The real EventStore/native-adapter regression covers three claims,
but it is a synthetic transport test, not live multi-turn model acceptance.

Official [Google global endpoint documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/use-partner-models)
lists Haiku 4.5 at `aiplatform.googleapis.com` with `/locations/global`.
[Anthropic's model table](https://platform.claude.com/docs/en/models/overview)
lists `claude-haiku-4-5@20251001` for Google Cloud. These public facts do not prove
access for a selected credential. Announce the exact account and model before
any separately authorized inference test.

## Pinned CLI contract and offline validation

The implementation follows OpenShell commit `854b2370b`:
`crates/openshell-cli/src/commands/provider.rs` implements explicit credentials,
project/region config, refresh configuration, rotation, and bounded census.
`--secret-material-env` automatically marks supplied material secret. The
server handler in `crates/openshell-server/src/grpc/provider.rs` unions these
keys with profile-declared secrets; non-secret `client_id` may also be protected
this way. `crates/openshell-providers/src/providers/vertex.rs` projects the
configured Vertex project/region aliases. No upstream files were changed.

Offline tests use synthetic credentials and injected auth/CLI responses. They
cover same-snapshot consistency despite file replacement, verified principal,
quota-project drift, file bounds/ownership/mode/symlink/type, explicit dated
model selection, profile replacement, provider identity, refresh failure,
secret redaction, custody loss, and the actual bootstrap integration. They are
not physical gateway or model acceptance.
