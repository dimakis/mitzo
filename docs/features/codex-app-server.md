# Native chat lifecycle and account deployment

The ChatGPT subscription route uses a managed Codex app-server process. Enable it
explicitly with `MITZO_CODEX_ENABLED=1`; the development-only alternative is
`MITZO_CODEX_DEV_ENABLED=1` outside production. Work OpenAI accounts use the Responses
API through the native runner. Vertex retains the Claude Agent SDK route. Providers
never silently fall back to each other.

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
  Codex login roots, including symlink aliases. Directory listings load the account
  configuration once per request. Previously known private roots stay protected if
  a profile is removed or the profile file becomes unreadable, while ordinary
  browsing continues. A cold start with no valid root snapshot still fails closed
  until the configuration is repaired; unknown credential paths cannot safely be
  guessed. Non-missing-path resolution errors also deny access.
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

Restricted skill tool ceilings, images, subagents, and compaction are not supported
by the Codex route. New conversations advertise Read, Write, Edit, Bash, and
AskUserQuestion. Mutating tools can request a real approval card with
`require_approval: true`; configured permission policy remains authoritative.
Native Codex requestUserInput requests also use the shared question cards.
Only provider reasoning summaries are displayed, never raw private reasoning.
Resumed provider threads retain their original dynamic tool catalog: start a new
chat to obtain newly introduced tools.

## Credentials and project hooks

OpenAI API profiles use a credential reference, for example
`{"provider":"keychain","service":"com.mitzo.openai","account":"work"}`.
The credential resolver registry accepts additional provider implementations.
Resolution fails closed; secrets are not stored in account profiles, tool
environments, or session metadata. The API model is fixed for the conversation.
Its private native history is separate from the Codex durable follow-up queue.

Supported command hooks are SessionStart, PreToolUse, PostToolUse, Stop and
SessionEnd. Unsupported hook kinds fail explicitly. Hooks execute with a temporary
private HOME and the project directory in CLAUDE_PROJECT_DIR; they do not inherit
personal HOME credentials. Startup context is appended to the prompt, pre-tool
updates are revalidated, denial blocks execution, and ask requests an approval
card. A post-tool failure reports that the tool already ran; it must not be retried
blindly. Stop hooks gate completion. This is a bounded compatibility layer, not full
SDK hook parity; nonblocking Stop context is not injected as another model turn.

## Deployment verification

The integrated branch includes structured questions and approval acknowledgement
from #454, on top of merged #453 and #455. Automated coverage includes permissions,
queue recovery, native hooks, credential redaction, API routing, reasoning summaries,
and account startup/navigation regressions. The full suite passed 3,431 tests before
the final desktop feedback and alias-read tests; CI validates the final commit.

Live testing verified a Keychain-backed Responses Read call and answered structured
question. A fresh Luna conversation displayed a real Write approval card; denying
it left the file absent. Earlier checks covered Luna/Terra model changes, aliases,
and Read/reconnect behavior. The iOS app builds and signs successfully; installation
and physical-phone acceptance remain deferred. These checks do not establish full
MCP, long-history, changed-tool-catalog, or physical-phone parity.
