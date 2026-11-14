# Restricted skills: original SDK command ceiling

PR [#1342](https://github.com/dimakis/mitzo/pull/1342) incorporates the restricted
skill work originally published in #1343. There is no separate #1343 landing.
The [restriction contract](restricted-skills.md) defines exact-name and dependency
intersection semantics. Public restricted-skill prompt admission remains refused;
these internal enforcement primitives do not enable an unqualified adapter.

The existing `ordinary/send` ledger and `ordinary_skill_context` event retain an
optional exact-name `allowedTools` array. Omission adds no ceiling; an empty array
denies every tool. Admission clones and validates the complete record before its
callback, compares it on retry and commits in the existing transaction. Cold
recovery reads that retained context rather than resolving changed skill files.
Derived commands must preserve the source context through canonical admission.

The existing FIFO command owner captures the context with the original execution
generation. Before releasing stdin it binds one command tool authority to that
SDK query. Restricted commands refuse a query without that binding interface.
Each tool check revalidates runtime, active command, execution generation/phase
and unchanged durable context, then applies shared `checkSkillTool` semantics.
Stop before input keeps that command unreleased; Continue binds the retained
successor to its own query. A late callback cannot borrow the successor's ceiling.
Authorized steering retains the active query's original ceiling.

`SdkCallbackState` retains the authority once per query. PreToolUse and canUseTool
check it before and after existing awaited hooks/permission owners. Managed
connection, information, Telos and web handlers check their actual wire names;
discovery/dispatch wrapper names cannot grant access to arbitrary targets.
Existing effect/approval owners still enforce account, operator, profile, mode,
workspace, cancellation, expiry and revocation. There is no new permission
registry, command queue, recovery store or delegation authority.

Enabling restricted prompt execution requires trusted initial admission to
resolve and atomically freeze effective dependency ceilings, followed by complete
public startup/FIFO/steering/cold-recovery qualification. Native Codex and other
unqualified prompt adapters retain visible refusal. Agent/Task/session creation
cannot inherit a qualified ceiling merely by appearing in an allowed list.

Original implementation history is retained in #1342, including `98c0b9217`
(ledger), `0e8e80d20` (FIFO authority), `07f45c255` (SDK callbacks), `15a926c21`
(replay), and `8b97c9217` (peer inheritance). The 13 November handoff and its test
counts are historical evidence, not current-head acceptance. Current composition,
negative controls and remaining gates are in
[the delivery evidence](../evidence/claude-parity-1342-reconciliation-2026-11-14.md).
