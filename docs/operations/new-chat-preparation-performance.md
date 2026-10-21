# New-chat preparation timing

The October 21 post-deployment sample on `1886f505` contains three naturally occurring new chats. Server receipt to provider dispatch took 9.047, 9.922 and 11.203 seconds; first persisted assistant text took 13.575, 13.824 and 15.693 seconds. This is a small observational sample, not a controlled benchmark.

The first selection already reuses its exact one-use publication receipt. Task-capability inspection overlaps knowledge preparation, and the measured lifecycle wait is negligible. The remaining 1.30–3.48-second gap after the initial frozen seed and before provider-environment admission covers cold sandbox creation/upload, readiness and post-create checks. Existing spans do not isolate those operations. A synchronous SQLite timer load was observed separately and can also delay callbacks; external command wall time alone cannot distinguish that load.

## Bounded changes

Runtime attestation and immutable-cache integrity/presence inspection now start together after the fresh physical-owner check. Both remain fresh read-only SSH operations. Both settle before any cache invalidation, host freeze, repair, upload or release of lifecycle custody, including errors and cancellation. Runtime failure keeps precedence; malformed cache replies fail closed. Every existing physical ownership recheck, delivery receipt, account/runtime policy attestation and first-command selection identity remains mandatory.

There are still three knowledge SSH exchanges per admission; the first two occupy one parallel wave, followed by final delivery after validation. The observed cache-probe spans were approximately 0.15–0.27 seconds, so this removes a sequential interval of that size in those traces. Offline held-operation regressions prove overlap and failure ordering; post-change production latency has not been measured.

Cold seed preparation without a capacity callback now verifies the selected source once, captures and copies it synchronously, and independently verifies the frozen result. Previously it verified the source twice plus the frozen copy. The existing first source verification spans were approximately 0.08–0.15 seconds. Exact publisher baseline/revision binding still validates the frozen result, including concurrent source replacement. Capacity and migration callbacks can yield; their post-callback source verification remains mandatory. Later-command host verification is unchanged.

The initial upload initializes the writable task checkout. First-turn delivery installs and validates a separate immutable knowledge view. Both lanes remain separate. Provider initialization and policy handoffs remain freshness boundaries; their runtime/provider observations are not reused across them.

## Attribution

Fixed `codex.startup.*` spans cover existing startup error phases. Fixed `openshell.ensure.*` spans now cover account/provider checks, current/legacy sandbox reads, connection checks, create, phased seed upload, readiness and provider reconciliation even without an optional diagnostic observer. They record status only, without paths, command arguments, output, account identifiers or exception text. Existing diagnostic callbacks remain observational.

PR #986 independently changes provider-environment retry readiness and new warm-claim knowledge selection. Its fixed ten-second retry was not observed in this sample. This change does not adopt or duplicate that PR, change the supervisor, retry an active turn or migrate credentials.

Validation uses synthetic offline fixtures and CI. No model call, test prompt, staging operation, production restart or deployment is part of this change. A separate authorized deployment and naturally occurring trace comparison are needed to measure the combined effect and select the next bottleneck.

## Historical Task Board preservation

Legacy deletion review may lack a durable client identity. A nonterminal Task Board task assigned to a disconnected client must then block cleanup as ambiguous unless a live conversation mapping or durable delegated-worker binding proves it belongs elsewhere. Blocked and pending-review tasks survive registry removal and are not reclaimed by the active-task orphan sweep. Protection is read again at confirmation, before lifecycle enrollment, checkpointing, stop or deletion; task ownership is never rewritten to qualify cleanup.

This deliberately can retain an ownerless sandbox because of an unresolved task that actually belongs elsewhere. Resolve the task's ownership or terminal disposition before retrying cleanup. Known unrelated ownership, terminal tasks and unassigned work remain outside that sandbox's custody; direct or durable evidence for the current conversation still blocks even if another binding conflicts.
