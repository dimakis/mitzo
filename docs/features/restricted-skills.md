# Restricted skills

Contract established before implementation, 13 November 2026. Source baseline:
Mitzo `9e47c4ab81d836673bacb461d2b03d46d8de390f`, Claude Agent SDK `0.3.322`.

`allowed-tools` is an exact, case-sensitive tool-name ceiling. Omission imposes
no additional restriction; an empty list permits no tools. A YAML string may
separate names with commas or whitespace; a YAML sequence contains individual
names. Wildcards, command patterns, mappings, non-string entries and duplicate
YAML keys are unsupported and must produce a visible resolution error. Invalid
restrictions must remain discoverable rather than disappear into an unrestricted
fallback. `requires-skills` must be a sequence of skill names.

Repository, user and bundled precedence selects each skill once. The effective
ceiling is the intersection of every declared ceiling in the transitive instruction
dependency graph. An unrestricted wrapper cannot remove a dependency's ceiling.
Missing dependencies, malformed metadata and cycles refuse resolution before
provider dispatch. No dependency grants additional tools.

The ceiling further restricts the published profile, mode, workspace and current
approval owners. It grants none of those permissions. SDK PreToolUse checks the
final input after project hooks, including tools the SDK would auto-approve;
canUseTool and managed executors retain their own checks. The shared permission
handler rechecks the current ceiling after awaited workspace checks and approvals.
Integration dispatch must also check the resolved target's original identity;
allowing a discovery or dispatch wrapper does not allow every target.

Delegated model execution has no qualified inherited ceiling. Agent/Task and
session-creation routes therefore refuse under an active ceiling, even when named
in the list. Removing the ceiling requires a subsequent explicitly admitted plain
user command; project instructions or cached approvals cannot clear it. A pending
permission decision must revalidate the ceiling before returning an allow.

This is a tool-call boundary, not command argument filtering or a semantic
read-only promise. Allowing Bash allows commands subject to its existing executor
policy; allowing an integration allows that tool's operations subject to its
existing approval policy. Skill text and provider claims are untrusted instructions,
not enforcement. Server-owned control-plane consent is separate from model-call
authority and cannot widen the skill ceiling.

| Engine / adapter                  | Restriction support                                           | Boundary                                                                          |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Legacy Claude SDK controller      | Exact tool names, dependency intersection; delegation refused | Mandatory PreToolUse, canUseTool, managed executor checks                         |
| Owned ordinary Local Claude SDK   | Unsupported                                                   | Composer catalogue reason and admission refusal before restricted prompt delivery |
| Local / OpenShell Codex           | Unsupported                                                   | Controller enqueue/start refusal; ordinary host composer refusal                  |
| Owned ordinary Responses / Gemini | Unsupported composer skills                                   | Existing ordinary composer refusal                                                |

Native skill readers, externally installed hooks and independently launched
workers are outside this controller contract. Unsupported routes stay unavailable
until their real execution boundary can carry and revalidate the ceiling. Offline
adapter evidence does not establish provider/live acceptance; no live model call
or deployment is authorized by this document.
