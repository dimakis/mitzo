# Local Mac personal Claude development

Personal subscriptions use the existing Claude Agent SDK development path with
the shared Mitzo permission handler. Native Bash, Grep and Glob are available
under those permissions, as they are for Vertex Claude. The personal account
does not add a second mandatory SDK Bash sandbox inside the protected SDK process.

On 13 November 2026, Dimitri explicitly prioritized restoring usable Local Mac
Claude and deferred the additional command-level credential sandbox. Its Unix
socket initialization conflicted with the outer process sandbox and prevented
ordinary Bash/repository work. Direct file requests targeting private account
paths still receive the existing denial; this is not complete credential isolation
for arbitrary shell commands or recursive searches. Do not claim otherwise.
Glob's literal pattern prefix also receives that canonical private-path check,
including absolute paths, relative search roots and directory aliases. This closes
the direct-pattern bypass identified by Centaur `CEN-A295D8A2E2C8` on 14 November;
broad workspace searches still follow shared permissions.

Account identity, billing selection, revocation, shared command approval and the
existing outer controller protection remain enforced. Claude on OpenShell is
outside this increment. A future isolation change must preserve working native
repository commands and search, and qualify the complete nested execution path.

`claude-native-development.test.ts` drives the real installed SDK Bash tool with
canned localhost Messages responses and disposable repositories. It makes no
real model call. The ordinary-chat integration test separately verifies that the
actual personal startup options omit the extra sandbox while private direct
file requests remain denied.

Linux unit runners install `bubblewrap` and `socat` and enable the user namespaces
required by the installed SDK's EnMaaS subprocess-scrubbing sandbox. The probe
retains its real Bash execution and repository-write assertions, with per-mode
SDK diagnostics attached to failures.

## Development continuation repair (14 November 2026)

Compared against main `f801f8df6cac9c1305727b85a7235928eef2e175`, Agent SDK
`0.3.322`. The bootstrap reuses the existing implementation:

| Behavior                 | Legacy Vertex                                   | Ordinary guarded Vertex and personal Claude                                                                            |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Repository work          | `startChat` worktree setup and native SDK tools | Existing repository admission supplies the isolated checkout to the same SDK tools                                     |
| Commands and permissions | Shared SDK permission handler                   | Same handler plus the retained command, workspace and account authority                                                |
| Authentication           | Vertex ADC                                      | `claude-sdk-credentials.ts` selects ADC or personal subscription custody; identities and history roots remain distinct |
| Future input and history | Legacy streaming input and resume               | Both use `OrdinaryLocalVertexCommandOwner` and the credential-aware SDK query/history continuation                     |
| GitHub CLI               | Host CLI sign-in where authorized               | Both scrub controller `GH_TOKEN`/`GITHUB_TOKEN`; neither inherits controller publishing credentials                    |

The HTTP Stop route previously closed the guarded Claude query. That discarded
the opportunity to receive its original SDK result and left continuation blocked
by an unsettled execution. Stop now invokes the existing exact-target interrupt
and keeps the owner alive to record the result. Its acknowledgment alone does not
settle effects. Failed interruption retains activity and a sanitized diagnostic;
repeated Stop does not replay the interrupt.

Stop also persists before native input acknowledgement and during callback
settlement. A stopped input is skipped at its final synchronous yield fence;
no provider turn or settled-effect evidence is invented. If input was already
yielded, the exact interrupt waits for its original echo. A result already being
settled finishes through that owner and leaves successors paused. Starting the
next command after a cancelled first input retains the selected account and SDK
session identity without requiring a transcript that was never created.

The public queue Continue route previously waited for a Codex runtime even for
Claude. It now calls the retained Claude queue owner, checks the original operator
and current authority, and releases queued input only after the previous result
has settled. Concurrent Continue requests cannot abort the new command. This is
the same repair for ordinary Vertex and personal Claude; no new runtime, adapter,
repository helper or queue is introduced.

Session metadata exposes this queue and its signed `canContinue` capability to
the existing `CodexQueueStatus` control. The control therefore includes the
current transport connection identity, as required by the Continue handler.

Evidence and limits:

- `ordinary-local-vertex-chat.test.ts` reproduces the failures through the actual
  HTTP Stop and Continue handlers for both accounts, then verifies retained
  checkout/account, transport detach/reattach, FIFO continuation, subsequent Send,
  foreign-operator refusal and visible interruption failure. SDK inference and
  sign-in verification are canned; the repository and admission owners are real.
- The public journey also holds personal account verification and real callback
  settlement across Stop. Its Continue request follows actual metadata, matching
  the existing component's signed-header behavior. Owner/evidence tests cover
  settings preparation, delayed input echoes and refusal to replay an interrupt
  using a different request ID.
- The existing integration cases retain cold Send/history continuation, frozen
  settings, credential refusal and abrupt-runtime-loss uncertainty checks.
- `claude-native-development.test.ts` runs the installed SDK's real Bash tool
  against canned localhost Messages responses: edit/search, a shell assertion,
  local commit and push to a disposable bare Git repository. This proves local
  Git execution, not GitHub authentication or remote PR creation.
- Browser/device reconnect, live personal sign-in and an authorized GitHub
  push/draft-PR/CI-reading journey still require acceptance testing. No live model
  call, production activation or deployment is part of these offline checks.
- Queue Continue requires its live owner. After a cold restart with settled work,
  Send in the same conversation uses the existing history-resume path. Abrupt
  termination without original terminal evidence remains blocked; this repair
  does not invent a successful outcome or retry an uncertain provider effect.

PR #1342 was inspected as draft/open/conflicting at `b2675af8` on 14 November;
its TaskExecution/helper registration and integration work remain separate.
PR #1346's Bash/Grep/Glob repair and authorized sandbox deferral are preserved.
