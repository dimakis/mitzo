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
an optional `workspaceId` for team/business/enterprise accounts, and `models`
containing explicit `id`/`label` pairs. Use an available low-cost model
such as `gpt-5.6-luna` for smoke tests. Never put tokens in this profile file.

The adapter passes an allowlisted environment to Codex, excluding API keys and
alternate-provider variables, and requires ChatGPT authentication. Account metadata
is checked at initialization and before every queued turn. The durable application
binding pins the selected account configuration and starting model. Each queued
turn records its selected model from that account’s current allowlist; changing
models between turns does not change subscriptions. Model/provider fallback is disabled. No automatic login, logout, or token copying occurs.

The installed CLI's account schema exposes email and plan, not stable workspace
identity. Configure `workspaceId` for organizational accounts; Mitzo passes it as
Codex's forced ChatGPT workspace and includes it in the durable binding revision.
Without it, external changes to a shared login can still race the per-turn check.

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
- Interrupt pauses remain deliberate. Transport loss in an ordinary legacy chat
  automatically reconnects already queued work, with five transport attempts after
  1, 2, 5, 10 and 30 seconds. Account, workspace and provider binding are reverified;
  metadata-only native turn status must be terminal before FIFO dispatch. The lost
  command is preserved and never replayed. Stop cancels pending and in-flight
  recovery. A second lost automatic follow-up does not drain further saved work.
- Transport eligibility is persisted separately from a generic recovery pause and
  survives cold reattachment. Historical pauses without this qualification retain
  explicit continuation. Guarded ordinary routes, terminal transports, Symposium
  and capacity recovery keep their existing owners. After bounded retries fail,
  the existing reconnect fallback remains available. Check current state before
  retrying an uncertain action. Successful continuation refreshes queue metadata
  without leaving a stale attention banner.

## Approved environment changes

A successful integration attachment refreshes the retained OpenShell transport
before its next provider turn, preserving the exact account and conversation.
When an ordinary user chat discovers that missing access during a turn, the host
records its exact tool result and queues at most one trusted continuation of the
original request. The access result tells the current turn to defer commands that
need the changed credentials. The continuation runs only after the exact source
turn completes and the retained thread generation still matches. It asks the
agent to inspect completed work and continue only unfinished authorized work;
it does not replay the original prompt or previous mutations.

An already queued user follow-up serves the refreshed environment instead. A
new explicit follow-up cancels an undispatched synthetic continuation. Stop,
failed/interrupted turns, conflicting identity and restart recovery retain normal
pause fences. Historical commands without raw user intent do not synthesize
authorization. Externally owned execution-ledger sessions do not create synthetic
children; their next reviewed command can use the refreshed transport.

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
AskUserQuestion. Bash is a Mitzo host tool using a separate OS sandbox, not
Codex-native execution; see [unified permissions](../design/unified-chat-permissions.md). Mutating tools can request a real approval card with
`require_approval: true`; configured permission policy remains authoritative.
Native Codex requestUserInput requests also use the shared question cards.
Only provider reasoning summaries are displayed, never raw private reasoning.
Codex `config/read` can return `null` for an unset reasoning-summary preference.
Mitzo treats this as unset: explicit OpenShell routes default to `auto`, and host
routes default to `detailed`. Explicit `none`, `auto`, `concise`, or `detailed`
preferences remain authoritative; unsupported values still block admission.
Resumed provider threads retain their original dynamic tool catalog: start a new
chat to obtain newly introduced tools.

## Credentials and project hooks

OpenAI API profiles use a credential reference, for example
`{"provider":"keychain","service":"com.mitzo.openai","account":"work"}`.
The credential resolver registry accepts additional provider implementations.
Resolution fails closed; secrets are not stored in account profiles, tool
environments, or session metadata. The API model is fixed for the conversation.
Its private native history is separate from the Codex durable follow-up queue.

The enrolled Local Responses runtime offers existing configured OpenAI API accounts
as well as new Connections enrollments. It reuses the selected account's credential
reference and its existing rotation/enrollment controller. Missing enrollment custody,
unresolved credential journals and account changes remain blocking; re-entering a
key or creating a second account is not required to select an existing account locally.
The enrolled OpenShell picker also includes existing API accounts with a configured
provider name and pinned provider ID. Owning admission checks the existing credential
custody under its mutation gate and verifies the exact provider ID, type and workspace
before sandbox effects, without copying the host key. An unpinned API profile remains
available locally; it cannot establish a new explicit sandbox route.

When Local Mac Codex is enrolled, host account discovery uses that runtime's pinned
native executable for metadata-only account and model checks. It does not depend
on the globally installed CLI version, start threads or perform inference. Existing
Mac sign-ins can be registered as host account profiles using their actual verified
identity and login directory. A differently signed-in sandbox account keeps its own
profile; registering a Mac account does not replace that account or copy its tokens.

Project command hooks are disabled by default because their commands are repository-
controlled host code. An operator may explicitly trust them with
`MITZO_TRUST_PROJECT_HOOKS=1`. Supported events are SessionStart, PreToolUse,
PostToolUse, Stop and SessionEnd; unsupported hook kinds fail explicitly. Trusted
hooks execute with a temporary private HOME, a narrow environment allowlist, and the
project directory in CLAUDE_PROJECT_DIR; they do not inherit credential variables.
Startup context is appended to the prompt, pre-tool
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
