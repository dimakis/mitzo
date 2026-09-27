# Selected Work Vertex provisioning

This bootstrap groundwork does not enable Vertex seat admission. The production
attestation still excludes `anthropic-vertex`; Claude runtime verification,
per-seat policy/isolation evidence, and continuation semantics remain separate
gates. No existing account profile is migrated or altered.

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
background refresh finished; admission must inspect current refresh readiness
and expiry before relying on it. The initial token was authenticated from the
same selected snapshot. A failed/uncertain startup returns no binding; the existing
bootstrap stops its newly owned gateway. Do not retry or adopt that provider.
The code does not claim restart recovery.

`captureSymposiumWorkVertexProvider(gateway, providerId)` supplies an immutable,
same-process receipt containing the Google-verified principal and selected
account/project/region/model bound to the created provider identity. Only the
original gateway object with live custody can retrieve it; observing custody
loss removes the retained capability. Serialized account metadata cannot
reconstruct it. No parallel ledger or scheduler is introduced.

## Proof limits

The pinned OpenShell CLI lists config **keys**, not config values or resolved
profile workspace. This increment proves acknowledged creation with exact
public intent, fresh identity census, and exclusive retained gateway custody;
it does not claim public-config readback. Future admission must verify the
resolved endpointless profile and native projected project/region before
execution, as well as cross-account, binary and filesystem restrictions.
Provider rotation does not prove model enablement or prediction IAM.

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
