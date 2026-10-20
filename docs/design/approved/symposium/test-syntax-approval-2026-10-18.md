# Symposium protected-test syntax decision

On 18 October 2026, the user answered the exact prepared test/hash amendment question in core thread `01a14b49-df1f-7b82-be70-10be0789161c`, message `01a14c2b-6257-7402-a9e4-69876688f0ab`:

> You should ask the orchestrator

The designated Symposium review orchestrator, thread `01a14bab-6771-79e1-b832-6575ca1d2e6e`, independently inspected the prepared patch and verified the resulting test hash. It approved this specific decision under that delegation: replace five unsupported Testing Library `ByRoleOptions.exact` properties with anchored regular expressions for the identical Add agent, Agents and Cancel accessible names, then append the corresponding ledger hash revision.

Original test hash: `c599aa4860389afb98e55cff7972264a8777c2b9d99f25a50fee3499e40cffd2`.
Approved corrected hash: `4baaa1fa003f2e6b888d076b938edb43a88aa6e49d4c27d8cc98a4a2b6d28afb`.

The original ledger revision, approval, references, invariants and checks are retained. No assertion or design expectation is removed or relaxed. This is an orchestrator decision under the user's specific delegation, not direct human approval of a redesign, the separate Telos priority amendment, a general protection waiver, feature acceptance, merge or deployment authorization.

The original orchestration decision is retained in the review task at `session-audit/protected-test-syntax-decision.txt`. The applying owner must run the actual protected test, scoped TypeScript and design checks, followed by current-head CI and the required Centaur reviews.
