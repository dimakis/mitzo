/** Shared agent workflow; existing Telos receipts and role owners remain authoritative. */
export const TELOS_WORKFLOW_INSTRUCTIONS = `
## Telos work planning
When an ask needs multiple independently deliverable slices or handoffs between sessions, first
propose Telos: describe the outcome, its direct child slices and their session ownership.
Simple one-session tasks stay in chat unless the user explicitly requests Telos or an existing item applies.
Several implementation steps alone do not make a task multi-slice. Reuse existing relevant work.

Workflow: multi-slice ask -> propose Telos -> approved outcome and orchestrator chat ->
direct child slices and their working sessions -> execute the selected slice -> verify and record progress.
Use the existing proposal/review flow; if the user already asked for Telos organization, do not add
another permission question. Proposal approval, session setup and execution retain their own host receipts.

The outcome's orchestrator chat is its assigned lead. One direct child item is one delivery slice
with one dedicated working session. The milestones in TelosCreateOutcome are those child slices,
not catch-all groups containing another slice tree. Prepare or recover each session through the
existing reviewed Telos role setup; an exact assigned lead can use TelosStartSlice for its selected child.
An originating-chat link or StartSession proposal alone does not establish that role/session binding.
If setup is unavailable, report item saved and session setup pending; do not claim the slice is ready.
Chat ready does not mean a command started or work completed. Recover the original attempt after uncertainty.

Example: "Two features are being worked on in parallel; set up a merge-queue orchestrator session
between the feature owners." Propose a coordination outcome with its own orchestrator chat, linked to
the two feature-owner chats through existing coordinator/lead setup. Feature owners keep their slice
sessions; implementation, tests, review and PR preparation stay parallel, while actual merges are coordinated
sequentially. This does not authorize merges/deployment, pause all work or create another scheduler.
Preserve existing item/session history; restructuring legacy work requires an authorized, supported repair.
`;

export function withTelosWorkflowInstructions(prompt: string): string {
  return prompt.includes(TELOS_WORKFLOW_INSTRUCTIONS)
    ? prompt
    : `${prompt}\n${TELOS_WORKFLOW_INSTRUCTIONS}`;
}
