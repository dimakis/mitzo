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

Landing corrections, 5 November: integrated accepted main `f9b0f3a1e`, retained
both branches' source registrations, and repaired the extracted watcher's idle
shutdown guard. Both chat views now get the skill catalogue directory from the
existing session metadata hook; a regression verifies that changing conversations
clears the old directory before adopting the next one. Focused hook, resolver,
composer, settings and design checks, the owned-native skill dispatch regression,
lint, workspace package compilation and source verification pass. The broader
owned-native fixture suite still depends on private host account configuration
unavailable under this chat's filesystem profile; its isolated skill regression
passes without that access. Full server/frontend compilation and browser checks
remain mandatory CI gates.

Centaur corrections, 6 November: ordinary admission now commits expanded and
passthrough skill decisions atomically with the original command. Saved commands
without a skill-context record preserve their original text. Initial, queued and
cold Claude SDK inputs consume the frozen prompt while visible messages retain
the slash text; the existing joined SDK fixture now asserts all three deliveries
and single delivery of attached source snapshots. New drafts read skills from the
selected qualified prepared workspace, including repository overrides, without
falling back to another catalogue. The existing-chat browser fixture no longer
overwrites its restored draft. Focused rollback, passthrough, workspace catalogue
and owned SDK admission checks pass. The joined SDK fixture reaches a host path
canonicalization fence locally before provider input; its full delivery assertions
remain a required CI check. No model calls are made by these fixtures.

The real prepared-checkout regression also verifies that catalogue discovery reads
the retained source before a conversation or task directory exists. The repository
owner rechecks account/source authority before and after that read and does not
reserve, claim or materialize a task. A revoked source refuses the catalogue. CI's
mobile screenshot showed that the isolated composer fixture sat at the top of an
otherwise empty viewport, placing its upward menu offscreen. It now reuses the
existing bottom-composer fixture layout; real clicks and all draft assertions stay
in place. The manifest formatting correction was checked across all changed files.

The desktop icon-only Terminal links now have an explicit accessible name. A
regression hides their visual labels and checks both router and plain links; the
router round-trip tests also retain edited drafts for new and existing chats.
Early source-snapshot and reply validation remains before native startup, with
skill expansion deferred to the atomic command admission. The existing altered
Library snapshot regression verifies that neither dispatch nor native RPC starts.

Passing phone/desktop captures use `responsiveness-runtime-tools-*.png`, retained
by the existing responsiveness artifact upload. New and existing chats have
separate images; mobile captures keep the supported actions open after the verified
Terminal round trip so the controls and retained draft can both be inspected.

Final integration, 6 November: merged accepted main `3219df3f7` with its native
subagent controls, preserving both source inventories. First-command freezing
now resolves repository skills from the qualified reserved source before the
future task directory exists. The repository owner checks reservation identity,
account, source and root around that read. The resulting prompt commits with the
command under the existing admission fence; retained decisions still take priority.
The real preparation regression covers repository-only instructions, a restricted
repository override, absent destination files and rejected account/source access.

Independent review corrections, 6 November: existing ordinary catalogues now
select the conversation ID and use its real workspace custody. Terminal resolves
through that same session-qualified path authority. The joined HTTP regression
uses the default `.local/share/mitzo/ordinary-tasks` layout outside configured
repository roots and rejects a substituted cwd. Local HTTP execution reaches an
`EPERM` in the private-path guard (including the existing file-list journey), so
the complete route assertions remain CI evidence; the guard is preserved.

For configured local repositories that will create a worktree, catalogue and
first-command resolution read committed `SKILL.md` bytes at the retained base
revision. A bounded temporary view carries only those files and is removed after
the read; it is neither cached nor watched. Source branch changes, dirty files
and skill symlinks cannot replace the pinned instructions or restrictions. An
existing-directory selection continues to read its actual retained directory.
