# Tool Builder

Tool Builder is a built-in agent profile available from regular chat settings. It searches the installed tool catalog before proposing new work. A catalog match is a reuse recommendation; it does not assign the tool to an agent. Reviewed API templates remain configuration-only and use their existing connection and verification boundaries.

## Draft and review contract

- A custom draft has a stable tool ID and draft ID, an increasing draft version, a strict input schema, examples, declared permissions, supported routes, source files, test profile, source digest and complete test evidence.
- Draft files are written beneath the current session's authorized worktree in a private, isolated directory. Relative paths only are accepted. Symlink paths and traversal are rejected.
- Tests run through Mitzo's bounded sandbox command service with networking and credential paths excluded. The example runner loads the exact draft source only in that test sandbox. The product runtime never loads draft files.
- A passing test receipt binds to the digest of the complete source file set. Source changes during testing, incomplete runs, cancellation, failed tests or example mismatches prevent draft persistence.
- Review submission pins one draft version and digest. A separate reviewer cannot review their own draft. Revisions create a new version and retain the reviewed version and its evidence.

## Publication and selection contract

The private draft ledger is not an executable tool registry. Publication requires an accepted review for the exact source digest and a code-installed implementation entry that matches the tool ID, immutable implementation version, source digest, executor identity and requested route. Publication records a new immutable revision. The runtime does not import source from the draft database.

Only code-installed implementations can enter the selectable catalog. The existing agent-tool selection and admission path remains responsible for exposing an explicitly selected implementation to a new session. Publication does not assign a tool, grant credentials, approve a connection or change permissions. Active-session tool refresh remains unsupported.

The Tool Builder's file editing and test capabilities are limited to its authorized worktree and named operations. The profile does not grant general shell access, arbitrary runtime execution, network proxying, credentials, or automatic review approval.
