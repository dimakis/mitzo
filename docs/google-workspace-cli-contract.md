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

Provider name and type alone do not establish the advertised permissions. Management exports the installed `mitzo-google-workspace-spike` profile in the provider's selected workspace and validates its safety contract against `docs/spikes/openshell-codex/google-workspace-spike-profile.yaml`: four exact Google read-only endpoints with enforced REST filtering and terminated TLS, the three bounded Slides rules, and the reviewed bearer credential binding, refresh schema and executable allowlist. Extra endpoints, write rules, weakened enforcement, credential routing or other policy drift fail closed. Cosmetic profile metadata and positive resource-version changes remain acceptable.

The primary CLI supports `provider profile export <id> -o json --workspace <workspace>`. Its export includes `scope` and `source` metadata, and serializes an unused credential `query_param` as an empty string. Read-only inspection on 30 September confirmed the exported safety fields match the reviewed YAML; no credentials were exported and no gateway or sandbox state changed.

Policy verification precedes host credential requests and every refresh configure/rotate operation, and is repeated around status observation. A failed check returns unavailable capabilities or an actionable instruction to restore the reviewed profile. Offline regressions change the policy before each operation to ensure a previous successful observation cannot authorize a later unsafe import or rotation.

## Separate owned-gateway contract

`server/symposium-work-vertex-readiness.ts` deliberately targets a separate owned gateway CLI pinned to upstream commit `854b2370b`. That CLI uses paginated provider-list objects and table-only refresh status. Its parser is specific to that owned runtime; it does not define the primary Connections gateway contract above. Google management does not support substituting that CLI for the primary production controller CLI.

When updating the primary CLI or gateway, revalidate the JSON shapes above before enabling Google management. Failed or incompatible observations return unavailable rather than advertising readiness.
