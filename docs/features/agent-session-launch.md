# Reviewed agent-created sessions and complete defaults

Agents on an owned ordinary Local Mac route can use `StartSession` to propose a
new Codex or Claude chat. The host resolves the saved complete default plus declared
overrides and retains the original request identity. The tool creates a pending
review card; it has no allocation or provider-dispatch operation.

Put the complete handover in `prompt`. The request retains that Markdown and
offers **Handover.md → File options** before and after startup. Browser Download
and native Share use the existing authenticated file flow; iOS receives file
bytes through its bridge. The tool's `handoverDownloadUrl` identifies the protected
API endpoint, not a workspace file or a permission grant. Temporary files such as
`/private/tmp/handover.md` are not a reliable cross-session or file-viewer handover.

The operator can edit the title, handoff and configuration, optionally save that
configuration as the default, and choose **Approve & start**. Approval and its
optional default update share one revision-fenced SQLite transaction. Cancelled,
stale or conflicting approvals cannot alter the saved default. Saving a default
retains intent, never permission grants, credentials or capability observations.

## Complete persistent defaults

The existing Chat settings Defaults surface now saves account/model/thinking,
public account identity, agent revision, execution location and exact target,
permission mode, isolation, repository intent, context blocks and additional tool
intent. The server stores this under the stable single-operator subject, making
it available to agents and other devices. New chats revalidate the saved target;
they never replace an unavailable Local Mac selection with OpenShell.

Fresh drafts wait for the default read before mounting their untouched composer.
Restored drafts, typed content and explicit setting changes retain their own
authority. Old reads/saves cannot overwrite another draft's settings. Context is
cleared on the exact accepted-send boundary, including when parent-controlled
context is removed as the newly created session becomes active.

A saved repository preparation is retained only as an unresolved source hint.
It cannot be claimed again or dispatched as a new session's checkout. The user
must select a fresh source or explicitly clear that selection. Native routes
show blockers for unsupported saved context/additional tools and provide explicit
clear actions; these settings are never silently omitted from a send.

## Startup, recovery and navigation

Startup uses the existing ordinary workspace, account/profile qualification,
command admission, native FIFO, permissions and provider owners. The new session
has a fresh workspace and empty permission grant list. Its authenticated operator
is retained for the session lifetime, so opening its page is not required before
it can use its selected messaging tools.

Allocation and command identities are durable before startup. Replaying a tool
request recovers its original default snapshot and proposal, even after defaults
change. Created and Started differ: Started requires the exact native provider
acknowledgement, including handoffs expanded by the normal slash-command owner.
Reading receipts never dispatches work.

The additional-tool field can require built-in tools already exposed by the
selected profile on the owned Local Mac route. This includes AgentCommunication,
TaskExecution, StartSession and SessionTimers in the default profile. Qualification
checks names, route and exact published tool versions; it never expands a profile
or copies the predecessor's grants. Missing selections require choosing a profile
that includes them. Calls still use their existing approval and revocation owners.

Static unsupported choices are explained before approval. A controller-confirmed
preflight refusal leaves an existing pending proposal editable with its handover
intact. That signal requires the same pending revision and no allocation; a lost
response, concurrent claimed request or post-allocation failure keeps its receipt
and retry fence. Unexpected failures retain bounded internal causes and log a
sanitized stage/code plus request, command and chat identities.

**Resume startup** is an explicit revision-fenced action for interrupted startup.
It reuses the original allocation/command and any original workspace reservation.
A live child, existing native history, admitted send command or missing retained
workspace custody prevents replay. An already admitted child uses its ordinary
chat recovery controls. Lost custody never authorizes a replacement checkout.

The originating chat retains a compact receipt with **Open chat**, an existing
`UiIcon` and the saved configuration behind details. The new chat shows its named
origin above the transcript and in Chat details. React Router links preserve
draft ownership; approval leaves the originating chat selected.

## Supported scope and verification

The startup route supports Local Mac Codex and Claude sessions. Each account
starts on the engine and workspace its ordinary New chat uses. Codex accounts start
an isolated, non-Git ordinary workspace (version-2 preparation) on the Codex
harness. Claude accounts (Vertex, subscription or API key) start on the Claude SDK
harness in a repository task of the configured primary Local Mac repository. The
launcher selects that repository under an identity derived from the frozen
allocation, prepares a version-1 repository session and lets the Claude SDK owner
admit the reviewed command through its prepared-first path. The Claude SDK owner,
its custody and chat startup own repository workspaces only; the launcher never
gives it an ordinary workspace. Qualification, the agent-profile/tool route and
dispatch follow each engine's existing ordinary owner; no launcher-specific
runtime exists.

Recovery uses each engine's durable start evidence. Codex needs its retained native
conversation and provider-acknowledged turn. Claude needs its repository
preparation receipt, retained SDK custody, and the exact reviewed command's consumed
input and execution admission. A retained Claude child without its receipt is never
reallocated, and either engine's retained history refuses a replacement startup.

Telos role setup (`TelosCreateSession`) still creates new children only on Local
Mac Codex. A new Claude Telos child is refused at proposal and before workspace
preparation, because Telos worker startup and its first-command authority qualify
only Codex. An existing idle Local Mac Claude chat, including one this route
started, can instead be adopted into a Telos role; see
[reviewed existing-chat adoption](telos-reviewed-chat-adoption.md).

OpenShell, other providers, repository launches, profile context recipes and
context blocks are retained as editable preferences but refused before startup.
Put self-contained context in Handoff prompt and clear Context for this route.
Tools absent from an explicit published profile remain unavailable. These choices
require their own qualified startup paths; they are never silently discarded.

The 10 November 2026 repair adds real ordinary-runtime coverage proving all four
coordinator tools reach native thread startup, exact authenticated handover bytes,
revoked/hidden-source refusals, profile/version limits, preflight races and native
API-base/bearer delivery to the file bridge. The new offline browser recovery
fixture covers saving Markdown, editable refusals, lost-response fences and drafts
in the existing mobile/desktop appearance matrix. Local rendering remains
unverified: browser startup encountered a macOS Mach-port permission denial
before the fixture ran. Retain that evidence and qualify rendering in CI; do not
claim device delivery from a mocked native bridge.

Offline regressions cover the native tool dispatch, durable defaults, edited
approval, default races, real ordinary workspace/native admission with simulated
provider transport, startup interruptions, exact recovery, draft/context retention
and shared UI components. Focused semantic TypeScript and lint checks pass.

The 19 November 2026 repair of Centaur finding CEN-34D28388A599 adds an offline
Claude ownership test through the real launch service, repository preparation,
ordinary dispatcher, Claude SDK owner and chat startup; only the SDK process is a
protocol peer. An approved Claude child's reviewed handover becomes the first SDK
input, interrupted startup resumes on its original receipt, and an exact retry
starts no second SDK process. The previous launcher, which gave Claude an
ordinary workspace, left the same child uncertain before SDK dispatch.

Source-bundled offline browser fixtures cover narrow WebKit/Chromium phones and
desktop Chromium, dark Mint/System and light Teal/Georgia, exact Local Mac host
restoration across new chats/reload, approval, receipt links, focus and retained
drafts. Actual browser execution remains unverified: the host still supplied the
Seatbelt marker after an escalation request, and the required guard stopped
before browser launch. No guard was bypassed. Full frontend/server typechecking
exceeded the repository's required 1 GiB local heap; full builds and the browser
matrix remain CI validation. No live model call, merge or deployment occurred.
