# Native discovery account proof

Discovery binds the account through the retained OAuth-verified host receipt,
its generation, the exact provider name/ID, and the same owned gateway custody.
The host checks that receipt around each asynchronous operation and native RPC.
Before opening the native client, discovery verifies the sole sandbox attachment
and unique provider ID/type/workspace. These checks remain mandatory.

The reviewed subscription launcher creates a synthetic local ID token for the
native Codex process. Its display email is `app-server@openshell.local`; the
synthetic token does not contain the real plan. Opaque upstream credential handles
carry authentication through the owned provider. Native `account/read` email/plan
therefore cannot equal, or prove, the real account verified during attended login.

The old discovery guard compared those display fields to the real host receipt,
rejecting a valid native bootstrap at `account-read`. The corrected guard requires
native account type `chatgpt` and retains the host receipt/custody checks. It does
not adopt synthetic identity, import credentials, switch accounts or permit API-key
fallback. This matches the existing `symposium-subscription-native.ts` seat path.

The source launcher SHA256 is
`ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb`, exactly matching
`TESTED_SYMPOSIUM_NATIVE_BUILD.nativeArtifacts`. No launcher, image or upstream
OpenShell changes are included. The regression failed under the old guard and
covers synthetic email with missing/unknown plan under the corrected guard.
Null, missing and non-ChatGPT auth and receipt changes remain rejected. Existing
provider substitution, stale publication and asynchronous custody tests also run.

This is source/mocked-test evidence. The staging attempt failed at account-read
with settled cleanup, but its raw account response was not retained; this fix
identifies a deterministic contract mismatch without claiming its unseen response.
A reviewed live discovery is still required. No inference has been tested by this
change, and successful catalog discovery alone does not authorize a model call.
