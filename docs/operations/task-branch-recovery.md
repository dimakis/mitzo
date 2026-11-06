# Recover an assigned task branch

Verified against source `d973b9bc96cb66541fe8c81c6327821745479d38` and offline
standalone/linked-worktree regressions on 6 November 2026. The reported incident
ran release `3326bac25bfd127d533c18bebd6cbc4e444e4943`; runtime activation of the
correction requires separate deployment evidence.

Mitzo retains the assigned task branch as part of its checkout claim. Creating
another branch inside that checkout leaves the directory and commits intact,
but the next host tool fails workspace validation. The original error used to
be discarded when bootstrap closed the physical transport, leaving only a
generic Codex disconnect. The Continue chat UI cannot correct a branch mismatch.

Agents should commit and publish from their existing assigned task branch.
Generic repository instructions to create a feature branch apply when no task
branch has already been assigned.

For an affected checkout, first inspect the retained assigned branch, current
branch, commit IDs, status and worktree ownership. Preserve untracked files,
tracked changes and all branch names. If the assigned branch is an ancestor of
the saved current commit and no other worktree owns it, an operator can advance
that branch to the saved commit and make HEAD refer to it again. Use an expected
old commit fence when updating the reference; stop if any inspected identity
changes. This restores the retained branch without resetting to its old commit.

Revalidate the original checkout before continuing. The existing authenticated
recovery flow still owns interrupted commands and uncertain tool outcomes;
repairing Git metadata does not acknowledge effects or replay a turn. Do not
delete task data, edit private runtime ledgers or bypass the checkout validator.

The regression tests exercise the branch switch, saved commit, validation
failure and restoration for both standalone repositories and linked worktrees.
Separate bootstrap and lifecycle tests verify that the reviewed diagnostic
arrives before physical closure can overwrite its cause. Other connection
failures require their own evidence; branch recovery does not resolve approval,
credential, provider or callback failures.

## Safe tool refusals through the Local Mac wrapper

The wider audit also reproduced a separate integration failure: the conversation
settled malformed or unavailable tool requests before execution, but the owned
Local Mac lifecycle bridge closed the connection when the same refusal passed
through it. Tests that called the conversation directly missed this wrapper.

The conversation now supplies private proof for its exact refused RPC. The
bridge retains the connection only for a matching pre-execution refusal under
the original current lease. Reused errors, uncertain ledger effects, stale
identity, cancellation and changed authorization still retire the transport.
Failed replies pass the same final response fences as successful replies,
because either response can resume provider inference. Offline tests exercise
both the real conversation/bridge composition and the native response transport.
This reproduced defect is not retrospective proof of every logged disconnect.
