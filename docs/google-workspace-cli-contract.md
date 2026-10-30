# Google Workspace management CLI contract

Google Workspace management uses the primary Connections gateway and the controller CLI supplied to `createConnectionsRuntime`. It uses the same provider inventory and refresh JSON contract as `server/openshell-runtime.ts`.

The production stack in `infra/openshell/production-stack.lock.json` requires gateway and driver version `0.0.116-mitzo.3`. The deployed controller CLI reports `0.0.116-mitzo.2`; its refresh-status help explicitly supports `table`, `yaml`, and `json`. The following read-only commands were verified against that production deployment on 2026-09-30:

```sh
openshell provider list -o json --workspace default
openshell provider refresh status google-workspace -o json --workspace default
```

Provider list returns a top-level JSON array. Each provider includes `id`, `name`, `workspace`, `type`, `resource_version`, `credential_keys`, and `credential_expires_at_ms`. Refresh status returns an object with a `credentials` array. Each refresh record includes `provider_name`, `provider_id`, `credential_key`, `status`, `expires_at_ms`, `last_refresh_at_ms`, `next_refresh_at_ms`, and `refresh_generation_id`.

The compiled Google management service was also run read-only against that deployment. It returned `health: ready` and `slidesEditing: true` after observing a stable provider census and matching installed expiry. This check exported no credentials and made no model calls.

## Effective policy verification

Provider name and type alone do not establish the advertised permissions. Management exports the installed `mitzo-google-workspace-spike` profile in the provider's selected workspace and validates its safety contract against `docs/spikes/openshell-codex/google-workspace-spike-profile.yaml`: three exact Google read-only endpoints with enforced REST filtering and terminated TLS, the three bounded Docs rules and three bounded Slides rules, and the reviewed bearer credential binding, refresh schema and executable allowlist. Extra endpoints, write rules, weakened enforcement, credential routing or other policy drift fail closed. Cosmetic profile metadata and positive resource-version changes remain acceptable.

The primary CLI supports `provider profile export <id> -o json --workspace <workspace>`. Its export includes `scope` and `source` metadata, and serializes an unused credential `query_param` as an empty string. Read-only inspection on 30 September confirmed the exported safety fields match the reviewed YAML; no credentials were exported and no gateway or sandbox state changed.

Policy verification precedes host credential requests and every refresh configure/rotate operation, and is repeated around status observation. A failed check returns unavailable capabilities or an actionable instruction to restore the reviewed profile. Offline regressions change the policy before each operation to ensure a previous successful observation cannot authorize a later unsafe import or rotation.

## Separate owned-gateway contract

`server/symposium-work-vertex-readiness.ts` deliberately targets a separate owned gateway CLI pinned to upstream commit `854b2370b`. That CLI uses paginated provider-list objects and table-only refresh status. Its parser is specific to that owned runtime; it does not define the primary Connections gateway contract above. Google management does not support substituting that CLI for the primary production controller CLI.

When updating the primary CLI or gateway, revalidate the JSON shapes above before enabling Google management. Failed or incompatible observations return unavailable rather than advertising readiness.

## Docs authoring policy (profile revision 9)

The candidate profile permits `POST /v1/documents` and
`POST /v1/documents/*:batchUpdate` on `docs.googleapis.com`, plus document reads.
It replaces only the profile's `documents.readonly` refresh scope with `documents`.
Drive, Gmail, Calendar and Sheets endpoints remain read-only. The recovery path's
existing Drive consent already authorizes Docs API operations, but OAuth consent
and enforced provider rules remain independent requirements. Google documents
creation ignores content fields; populate the returned document with batchUpdate.
See Google's [create](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/create)
and [batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
contracts.

Management accepts the complete revision-8 read-only Docs contract during rollout
and reports `documentsEditing: false`. Runtime attestation retains a byte-pinned copy of the accepted revision-8 profile and compares its complete normalized definition, so existing read-only providers remain admissible; mixed or broadened profiles remain blocked. It reports true only after checking the
complete authoring policy and matching profile consent schema. Mixed read-only
scopes/write rules, missing rules, extra write methods, and broader scopes fail
closed. The field describes verified endpoint policy; ready credential installation
is checked separately, and neither observation proves a specific user's document
access. An omitted field means the Docs policy could not be checked.

This source change does not import a profile, enroll staging providers, alter live
credentials, or activate production. After source acceptance, the operator must
separately review the selected runtime's provider configuration, update its effective
profile through the supported controller, and verify the installed refresh grant
supports Docs writing. Reconnect only if credential recovery is needed. Preserve
original provider/sandbox ownership and uncertainty evidence. Staging enrollment
and live acceptance follow `docs/operations/canonical-staging.md`; production
activation requires its own explicit user action. A chat approval or Connections
refresh cannot update endpoint policy. Do not claim live Docs authoring until a
permitted create, batch update and read-back have succeeded on the reviewed test
configuration.

## Local Mac chat reads

Owned Local Mac Codex chats expose the selectable `GoogleWorkspaceRead` tool
when the controller Google management runtime is configured. It supports Drive
search/metadata and text export, Docs/Sheets/Slides reads, and Calendar event
listing. This uses the existing controller sign-in; it does not give native
shell commands access to `~/.config/gws`, change OAuth consent, or attach a
provider to the chat's runtime. The existing management switch and reviewed
provider-policy checks remain mandatory. Other connection tools retain their
existing runtime qualification.

Each read prepares the configured Google account identity, then requires exact
request approval showing that account and the operation/resource. The controller
keeps the refresh/access tokens private. Only fixed Google HTTPS GET resources
are permitted, redirects are rejected, bodies are limited to 2 MiB, and the read
has a 30-second lifetime including approval. Runtime ownership, tool/skill
selection, cancellation, the current connection instance and reviewed provider
identity/revision are rechecked before requesting content and before delivery.
Errors omit raw OAuth, CLI and HTTP diagnostics. Large approved output uses the
conversation's bounded `ReadToolOutput` storage and current-owner fences.

The regression in `owned-local-codex-native-execution.test.ts` starts the actual
admitted chat route and production Connections bootstrap, executes synthetic
controller/gws binaries and substitutes only external Google HTTP and model RPC.
It covers discovery, approval, document content, denial, long-output retrieval,
connection removal during approval and credential non-disclosure. Service tests
cover URL/input bounds, policy/identity drift, cancellation, redirects and response
limits. These are offline tests; they do not prove a particular live Google grant
or document permission. No production or staging activation is part of this change.
