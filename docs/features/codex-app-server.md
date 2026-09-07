# Codex app-server chat lifecycle (development only)

The ChatGPT subscription route now connects to Mitzo chat through a managed Codex
app-server process. It remains hidden unless `MITZO_CODEX_DEV_ENABLED=1` and
`NODE_ENV` is not `production`. This is an isolated development integration, pending
end-to-end and physical-phone acceptance. The direct Responses API route remains
separate; neither route falls back to the other.

## Account and process ownership

A server-owned `MITZO_ACCOUNT_PROFILES_FILE` contains an array of account profiles.
A Codex profile has `provider: "openai-codex"`, `id`, `label`, an absolute
`credentialRef` to an existing Codex login directory, exact `email` and `planType`,
and `models` containing explicit `id`/`label` pairs. Use an available low-cost model
such as `gpt-5.6-luna` for smoke tests. Never put tokens in this profile file.

The adapter passes an allowlisted environment to Codex, excluding API keys and
alternate-provider variables, and requires ChatGPT authentication. Account metadata
is checked at initialization and before every queued turn. The durable application
binding pins the selected account configuration and model; model/provider fallback
is disabled. No automatic login, logout, or token copying occurs.

The installed CLI's account schema exposes email and plan, not stable workspace
identity. External changes to a shared login can still race the per-turn check.
These checks do not provide atomic pinning of a mutable login directory.

## Chat, queue, and tool behavior

- Canonical Mitzo conversation IDs map privately to provider thread IDs. Context
  assembled by the existing chat path is passed to the Codex thread and prompt.
- Streaming text and host tool events flow through the existing query loop and
  event store. Supported native tools and configured stdio MCP tools use Mitzo's
  permission handler. Dynamic tool requests must match the active thread, turn,
  and configured tool name.
- Follow-ups are durably queued before acknowledgement and deduplicated by command
  ID. Reusing an ID with different content is rejected. Tool attempts are claimed
  before execution; a duplicate is reported as uncertain and is not rerun.
- Private SQLite state lives under `MITZO_CODEX_PRIVATE_DIR` (default
  `~/.mitzo/private/codex`). Public file APIs exclude this directory and configured
  Codex login roots, including symlink aliases.
- Interrupt and process loss pause queued work. Startup marks unfinished commands
  interrupted. Queued messages require explicit continuation; interrupted actions
  are never automatically replayed. The chat status shows the saved queue and
  whether reconnection is needed. Check current state before retrying an uncertain
  action.

## Execution limits

Codex-native shell, execution, agents, apps, plugins, hooks, computer/browser,
image-generation, and inherited MCP execution are disabled through runtime
configuration. Inherited MCP names are explicitly disabled; supported configured
MCP clients are owned by Mitzo. Custom OpenAI provider routing is rejected.
Unknown host request methods are rejected.

An installed-CLI probe with a synthetic local model endpoint confirmed that an
unadvertised `exec_command` call was rejected without creating its sentinel file.
Built-in skill listing/reading remains available with the tested CLI flags. This
is not a general proof against future CLI tool surfaces. Revalidate the generated
protocol schema and advertised tools when updating Codex.

Restricted skill tool ceilings, configured project hooks, images, native Codex
structured questions, subagents, compaction, and reasoning-summary UI are not yet
supported by this route. Unsupported image/skill/hook requests fail explicitly;
this slice does not provide full feature parity. Shared question/approval UI work
is maintained separately and still needs integration acceptance. Account selection
also needs complete capability-aware attachment controls before activation.

## Verification and remaining acceptance

The tests cover transport failure, bindings, event translation, sequential queues,
command/tool deduplication, restart pause, cancellation, native/MCP permission
routing, private paths, dispatch, and explicit queue continuation UI. Existing
Vertex and SDK tests remain part of the full suite.

A live synthetic `MITZO_OK` turn using `gpt-5.6-luna` and an existing ChatGPT login
completed successfully through the conversation controller, without an API key.
This verifies controller execution and subscription access, not the full mobile
chat path. Full WebSocket/query-loop execution, shared question/approval behavior,
mobile layout, and physical-phone acceptance remain required before activation.
Long-history bounds and tool-catalog changes across resumed provider threads also
need further validation. Production deployment is outside this development slice.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
