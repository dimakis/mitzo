# Approval modes and reusable access

As of 7 November 2026, native Local Codex Auto selects `mitzo-native-auto`:
workspace writes and command networking are enabled. Agent keeps workspace
writes and restricted networking. Ask retains read-only workspace access.
Every named profile retains the same read ceiling, credential deny globs and
protected runtime files. Mode selection reaches thread creation and subsequent
turns; a mode change applies at the next turn. Historical profiles require fresh
admission before selecting the new profile set.

Automatic approval review remains unqualified: schema support does not establish
a working reviewer model, account or billing route. Native execution explicitly
uses `approvalsReviewer: user` and `approvalPolicy: on-request`. The Access dialog
reports that human review handles remaining requests. This does not change
Centaur's independent PR review or authorize publication, merge or deployment.

## Operator-selected grants

### Repository and source reuse, 7 November 2026

The Access dialog now offers **Reuse in**. Selected conversations retains the
original behavior. Development access can instead cover future chats and managed
host workspaces for the same repository, login and AI account. Membership comes
from the private repository claim ledger and physical source/task directory
identities, never matching remote URLs or a model-supplied path. Multi-repository
sessions and unmanaged workspaces retain selected-conversation grants. This
changes consent only; each chat retains its own admitted filesystem roots.

Development access covers arbitrary sandboxed project commands, tests, builds,
local commits and networking through `TaskExecution`. Its authorize operation
reuses matching consent for every selected worker. Requested GitHub repositories
also need their own matching read consent; otherwise the complete task still
requires review. A derived task retains parent grant IDs and cannot outlive,
replace or revive them. Revocation cancels running derived operations; invalid
derived tasks disappear from active status and remain explicitly revocable.
Native callbacks reuse development consent only for explicit network-only command
overlays. Opaque escalations, stdin and new filesystem access still require review.

GitHub repository reads, Google reads and Telos progress can be shared with future
chats using the same signed login and AI account. Google scopes are an exact
account email plus one file, Drive file listings, or one calendar. A file grant
covers its Drive/Docs/Sheets/Slides reads; listing permission covers metadata,
not file content. Folder-subtree grants are not implemented. Google uses its
existing private credential/provider owner and validates consent at reads,
retained-page access and native response delivery. Google reads currently use
the admitted Local Codex route.

Telos progress is a distinct capability for one item: evidence notes and existing
active/acknowledged/completed status transitions through `TelosUpdateItem`.
It does not grant general brief edits, archive/delete, source adoption, child
creation or lead assignment. The native Local Codex lead must still have its
current canonical role and item relationship. Consent is rechecked inside the
canonical mutation guard; revision conflicts and unfinished descendants remain
blocking. Other routes retain their existing approval behavior.

All broader scopes expire within eight hours and end on server restart. The UI
shows the resource, reuse scope, actual enrolled sessions, absolute expiry and
revocation. No new folder, credential, publication, merge or deployment authority
is added. Focused regressions exercise repository/account/login mismatches,
source replacement, command variants, parent revocation, Google resource
boundaries, Telos mutation revocation and Access form submission. Full compiler,
production build and rendered browser evidence remain required CI gates; local
full compilation/build exceeded the prescribed 1 GiB heap on 7 November.

Access → Reusable access → Manage reusable access offers:

| Capability                          | Scope and consumer                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Development commands and networking | TaskExecution commands and local commits; native Local Codex command approval with an explicit network-only overlay inside an admitted workspace. No filesystem expansion, opaque escalation, stdin consent or policy amendment.                                                           |
| GitHub repository reads             | `GitHubRead`, including retained output, for the exact selected `owner/repository`. Public reads remain credential-free; authenticated reads use their existing credential owner. No GitHub writes or shell networking.                                                                    |
| Public websites                     | Credential-free HTTPS reads on public DNS hostnames at the standard port through `RequestWebAccess`. Private/local addresses, custom ports, authenticated browsing and charged provider searches retain separate approvals. Redirects and address retries retain the grant and DNS checks. |

The operator explicitly selects conversations and a duration (15 minutes, 1 hour,
4 hours or 8 hours). The list shows every covered session and the absolute expiry.
Revocation from any member retires the entire grant. Grants live only in the
server process and do not survive restart. Their identity binds the signed login,
live session object, runtime owner, account binding and workspace paths. Local
workspaces also bind physical directory ancestry, including directory birth
identity; remote workspaces use their retained runtime identity and path metadata.
Account/workspace changes,
Ask mode, abort, replacement owners, expiry and revocation invalidate receipts.

Interactive browser authentication and a mutation-intent header protect the
operator routes. A grant request must also match the exact session context hashes
shown in the inventory; changing an account or workspace between review and grant
creation refuses the request. Agent tool inputs and internal tool credentials do
not create grants. An uncertain browser mutation requires an explicit inventory
refresh before another attempt. Authentication changes discard the dialog's
retained observations and selections.

Consumers check consent before effects and before delivery. Both web fetchers
recheck after DNS and immediately before each connection; native web/GitHub
callbacks register a final synchronous RPC delivery fence. Development consent
returns only `decision: accept` for one command's explicit network overlay, with
the existing native grant and callback fences. Later commands require fresh
validation. Expiry/revocation attempts to interrupt the unchanged development
owner; it cannot undo effects of a command already admitted. The command-only
contract avoids issuing a turn-wide overlay that could silently authorize later
commands after expiry.

Existing exact-command consent remains separate and bound to its command,
directory, access profile, account and thread. This feature reuses PR #1240's
accepted directory-identity checks and redacted audit stream.

The 11 November [approval notification change](approval-notification-churn.md)
adds explicitly displayed repository-read consent for recognized GitHub CLI
commands, shared by Codex and Claude/Vertex. Different CI jobs/logs reuse that
scope; unrelated commands retain exact consent. It also consolidates approval
delivery and suppresses repeated unread-chat alerts. Automatic review remains
unqualified; source implementation and offline tests do not prove deployment.

## Recovery and validation evidence

Recovered session `3950b08a-f0bc-8b83-85f2-da1096714c99` held local commits
`bd76e0c9c`, `ed3aecd6f` and `c53413d78`, plus ten uncommitted consumer/router
files. The original checkout is preserved. The implementation was copied into
the current task workspace and reconciled against main `10f84e3a9b1f`, including
merged PR #1240 (`9c71ab7`). Its nested-directory command consent and approval
audit changes are retained; the older competing audit store was excluded.

Focused regressions cover mode compilation and thread/turn selection, receipt
validation, exact-command scope, selected-session ownership, context changes,
expiry/revocation, directory recreation, protected filesystem requests, web
revocation during DNS and final RPC delivery, and UI authentication/uncertainty.
The intercepted `session-access` browser fixture exercises the real dialog on
phone and desktop, both themes, alternate accents/fonts, keyboard actions,
44px controls, wrapping, grant/revoke and preserved composer text. It uses no
backend or model calls. Local focused checks use one worker and a 1 GiB Node
heap; compiled application, full browser matrix and combined-result validation
remain CI evidence. These tests do not claim a live native kernel/model round-trip.

The UI reuses HomeDialog, MotionPresence, existing grouped cards, semantic
surface/text/border/danger roles, and shared spacing/type/radius/control-height
tokens. It adds controls inside Access and preserves the approved Chat settings
hierarchy and references. Matching CI screenshots remain required visual review
evidence before readiness is reported.
