# Chat runtime tools

Implementation draft, 5 November 2026. Source baseline: Mitzo main
`79c334fa1e640372c1f5c54cf60b24bee50a1970`. This record describes the feature branch;
it does not establish merge, deployment or client adoption.

The user reported that Host Mac chat disabled Terminal and Commands while the
standalone Terminal page worked. Composer gates inherited from retained Codex
admission rejected both first-command and guarded conversations, independently
of the server's supported terminal destinations.

Mobile and desktop now share a capability projection. New Host Mac drafts link
to the existing host terminal with their saved draft return route. Existing host
and sandbox conversations keep the exact session destination. A new sandbox draft
has no host fallback; metadata loading and multi-agent conversations stay blocked.
The terminal resolver's workspace/root checks remain authoritative.

Host ordinary Commands uses the shared skill registry without legacy app-command
dispatch. Prompt assembly resolves supported skills in the admitted workspace,
retains the original slash text, and freezes resolved instructions by conversation
and command identity for queued/restarted delivery. Exact lookup has no lifecycle
history cap. Existing account, native execution, permissions and queue ownership
remain in force. Tool-restricted skills and dependencies are disabled with a reason
and rejected server-side; scalar tool declarations are recognized too. Controller
commands such as models and paid reasoning require their existing product actions.
OpenShell skill discovery/dispatch is outside this host-runtime change.

The shared picker never carries choices across runtime/workspace changes. Failed
loads show an explicit message; disabled choices are skipped by keyboard navigation.
Selecting a command only edits the retained draft. Existing composer tokens,
controls and approved settings layout remain unchanged.

Verification on 5 November: focused unit/design checks and the real owned-native
dispatch regression passed. Existing host fixture tests that default to protected
private configuration cannot run under this chat's filesystem profile; the new
native test explicitly uses the fixture's isolated chat route. No real model calls
were made. The all-intercept browser fixture was listed successfully, but execution
was blocked by the repository's Seatbelt host guard even after approved escalation.
Browser screenshots/visual inspection and broad compilation remain CI evidence.
