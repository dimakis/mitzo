# Codex 0.171.0 upgrade

Verified 20 November 2026 against the official public macOS ARM64 release and
`@openai/codex@0.171.0`, the npm stable version at verification time. Both contain
the executable with SHA-256
`fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42`.

The shared runtime pin selects 0.171.0 for host version validation and subsequent
OpenShell image builds. Codex's offline `model/list` includes `gpt-6.2-sol` and
`gpt-6.2-astra`, each with low, medium, high, xhigh, max and ultra reasoning.
Mitzo already consumes this catalog dynamically. The reviewed API model catalog
also admits these IDs when the selected account advertises them; existing models
remain available. Bundled support does not prove a particular account's entitlement.

All permission declarations retained by the reduced fixture were regenerated
with an empty isolated home and compared byte for byte with the previous fixture;
none changed. The fixture, exact-artifact gate and CI downloader now select the
same new executable. No credentials or production configuration were used.

The existing metadata-only resume probe passed against the new executable:
6,294,925 bytes for full history versus 2,445 for metadata only, with retained
history and zero provider turns. Subagent schema qualification passed; it does
not qualify subagent execution or change delegation policy.

Local kernel qualification failed at the positive `command/exec` control with
exit 71: `sandbox-exec: sandbox_apply: Operation not permitted`. The approved
native attempt encountered the same host restriction. There is no successful
local kernel receipt. Required macOS CI runs the actual permission qualifier and
retains its output; a failed check blocks landing. The prior alias report remains
historical evidence, including its host-preexisting hardlink limitations.

The version-bound 0.160.0 legacy continuity bridge remains closed after this
upgrade. Saved proofs and histories are preserved; this change does not invent
compatibility aliases or silently rewrite old runtime receipts. Existing runtime
requalification/recovery is required where an old declaration is incompatible.

The source update does not install a production executable, rebuild a deployed
OpenShell image, activate a release or prove consumer adoption. Those operations
retain their separate review, CI and deployment authorization.

Evidence: [retained no-inference metadata and diagnostics](../../implementation-evidence/codex-runtime-0.171.0.json),
[official release](https://github.com/openai/codex/releases/tag/rust-v0.171.0),
[permission contract](codex-native-permission-protocol.md).
