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
binding pins the selected account configuration and starting model. Each queued
turn records its selected model from that account’s current allowlist; changing
models between turns does not change subscriptions. Model/provider fallback is disabled. No automatic login, logout, or token copying occurs.

The installed CLI's account schema exposes email and plan, not stable workspace
identity. External changes to a shared login can still race the per-turn check.
These checks do not provide atomic pinning of a mutable login directory.

## Chat, queue, and tool behavior

Desktop and mobile share the account/model picker. Existing Codex conversations
can select Luna, Terra, or another configured model for their next turn while the
subscription stays fixed. The picker is disabled during generation. Queued work
retains the model selected when it was submitted. Other provider routes retain
their existing binding policy.

The **Rename** control saves a display alias per stable account ID in the server's
`.mitzo/account-aliases.json`. Aliases apply across browsers and existing chats;
they do not alter credentials, account identity, or billing. Saving a blank alias
restores the configured label.

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
Unknown host request methods are rejected. The code-mode host dispatcher is enabled
for models that require a JavaScript tool wrapper (including Luna). Wrapped calls
still reach the registered Mitzo tools and permission handler; this does not enable
native shell execution.

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
Subsequent browser tests verified actual chat/query-loop/SSE execution, reply
restoration after refresh, desktop account controls, alias persistence, and a
Luna → Terra → Luna sequence in one conversation retaining earlier context. The
user confirmed the initial mobile-width chat flow worked. Live Luna Read calls
rendered the tool card, file contents, and final answer, including a browser refresh
during a follow-up read. The query loop now follows the same session object when
its client connection is rekeyed. WebSocket-specific and
shared question/approval behavior, additional tool/recovery acceptance, and full
physical-phone scenarios remain required before activation.
Long-history bounds and tool-catalog changes across resumed provider threads also
need further validation. Production deployment is outside this development slice.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
The local CLI-generated schema should be rechecked on version changes.

Account email matching deliberately requires the exact provider-reported value. Configure that value verbatim; preflight does not assume that differently cased login identifiers are interchangeable. The profile revision also retains the exact configured identity.
