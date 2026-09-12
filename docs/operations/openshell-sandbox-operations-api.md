# OpenShell sandbox operations API

These authenticated, operator-facing endpoints are intentionally read-only except for the existing lifecycle preview/confirm/consent flow. They never return credential grants, checkpoint paths, raw provider diagnostics, or Podman prune controls.

## Inventory and capacity

- `GET /api/openshell/inventory` returns `available`, `partial`, `collectedAt`, `scopes`, and `sandboxes`. A sandbox row has non-secret identity, runtime/lifecycle phase, age, checkpoint presence/digest/version, consent, sanitized failure, preservation blockers, and explicit capability fields. `status` is `verified`, `orphaned`, `missing`, or `unavailable`; a failed provider scope is represented in `scopes`, never as an empty inventory.
- `GET /api/openshell/capacity` returns collection health and timestamped metrics. `podman.usageBytes` and `podman.reclaimableBytes` retain `podman system df` semantics. `filesystem.freeBytes` and `filesystem.totalBytes` are authoritative host/Podman-VM filesystem metrics collected separately. An unavailable metric is omitted and marked unavailable, never reported as zero.
- `GET /api/openshell/lifecycle/audit` returns the bounded append-only lifecycle action audit.

## Guarded actions

`GET /api/openshell/lifecycle/:conversationId/preview` returns a five-minute single-use token, blockers, proposed action, and precise non-secret target identity. `POST /api/openshell/lifecycle/confirm` accepts `{ "token": "..." }`. Confirmation rechecks generation, physical sandbox identity, current blockers, checkpoint, and deletion consent. `POST /api/openshell/lifecycle/:conversationId/retention-consent` accepts `{ "enabled": boolean }`.

All three action attempts write actor, target identity, generation, outcome, timestamp, and sanitized error to the lifecycle audit. The safe preview response intentionally excludes checkpoint filesystem paths.

## Capacity admission

`MITZO_OPENSHELL_CAPACITY_WARNING_FREE_PERCENT` (default `20`), `MITZO_OPENSHELL_CAPACITY_HARD_FREE_PERCENT` (default `10`), and `MITZO_OPENSHELL_CAPACITY_RECOVER_FREE_PERCENT` (default `15`) must satisfy warning > recovery > hard. A serialized, fail-closed check runs directly before `openshell sandbox create`; it blocks only new physical sandbox creation. Reattach, start, restore, checkpoint-stop, and consented deletion remain available. There is no automatic Podman pruning.

## Handoff

The later UI PR should consume these endpoints, render unavailable/partial/stale states distinctly, and require a native confirmation showing the returned target identity before sending the preview token. The later Vertex runtime PR must add an explicit checkpoint/lifecycle adapter before setting capability fields to supported; unsupported providers must remain visibly unsupported and action-disabled.
