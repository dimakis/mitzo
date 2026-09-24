# Codex native web-search policy contract

Status: accepted contract spike for Telos outcome `11241b89c0aac3df`.

## Supported protocol

Mitzo's host and OpenShell Codex runtimes are pinned to `codex-cli 0.153.4`.
The host launcher runs `codex --version` and refuses to start if the executable
does not match that exact reviewed version. The lifecycle probe performs the
same check before opening app-server stdio.
The checked-in contract fixture was reduced from the schema emitted by:

```sh
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

The production OpenShell image independently pins the same CLI version in
`docs/spikes/openshell-codex/Dockerfile.mgmt-runtime`.

## Finding

The app-server schema has approval requests for command execution, file
changes, permission escalation, tool input, and MCP elicitation. It has no
server request that asks the host to approve a native web search before it is
sent, and `item/permissions/requestApproval` carries no search query or URL.
The `webSearch` item is observable through `item/started` and `item/completed`,
which is too late to promise exact-query approval.

`thread/start`, `thread/resume`, and `thread/fork` each accept a `config`
override. Mitzo can therefore recompute and apply `web_search` at a quiescent
thread-generation boundary. It must not attempt to change that capability
inside an active turn.

## Data flow and trust boundary

With native search enabled, a model-generated query travels from the Codex
runtime to the configured model provider's hosted search service. It does not
pass through Mitzo's tool permission handler, native-tool audit path, or the
OpenShell network gateway. Repository text, instructions, and earlier
conversation content may influence that query.

Mitzo may record the consent request, decision, effective capability
transition, actor, mode, backend, policy revision, timestamps, outcome, and
error. It must not store raw search queries, URLs, or opaque provider result
payloads in the security audit.

## Product decision

Native search uses explicit conversation-scoped consent with exactly two
choices:

- Deny.
- Allow provider-hosted web access for this conversation.

There is no “allow once” option because the pinned protocol cannot enforce it.
Ask, Agent, and Auto conversations all begin unresolved and therefore run with
native search disabled; selecting Auto is not treated as web-access consent.
If exact-query approval is required later, Mitzo must disable native search and
provide a brokered `WebSearch` tool/backend that it controls before dispatch.

## Reproducing the boundary check

`node docs/spikes/codex-web-search-policy/lifecycle-config-probe.mjs` performs a
no-model app-server probe against an installed `codex-cli 0.153.4`. It uses an
isolated temporary `CODEX_HOME` and starts a thread with search disabled. An
empty thread has no persisted rollout, so resume and fork are expected to reach
the provider-thread lookup and return `no rollout found`; that proves the
requests and their config objects were deserialized, not that a searched turn
ran. Mitzo's fixture tests separately prove that the resolved configuration is
attached to all three lifecycle calls. A live provider acceptance test remains
part of the later, explicitly approved Luna matrix.

The fixture test fails if the recorded schema adds a search approval callback,
loses lifecycle configuration, or starts exposing query/URL data through the
generic permission callback. When upgrading Codex, regenerate and review the
schema, refresh the reduced fixture intentionally, and rerun the probe.
