/** Shared agent workflow; existing Telos receipts and role owners remain authoritative. */
export const TELOS_WORKFLOW_INSTRUCTIONS = `
## Telos work planning
Telos is the durable work contract and handoff between sessions: retain the intended result,
why it matters, bounded scope, ownership, dependencies, sources, next action and evidence of delivery.
Write each brief so a fresh agent can continue without the originating chat. Use a concise title,
intent (what to achieve), rationale (why), and observable acceptance criteria (how to verify it).
Keep detailed plans and evidence in named artifacts referenced by the brief.
When an ask needs multiple independently deliverable slices or handoffs between sessions, first
propose Telos: describe the feature, its session-sized slices and their session ownership.
Simple one-session tasks stay in chat unless the user explicitly requests Telos or an existing item applies.
Several implementation steps alone do not make a task multi-slice. Reuse existing relevant work.

Work model: outcome -> feature items -> session-sized slices. An outcome coordinates a shared result
across features; a standalone feature does not need an invented outcome wrapper. The outcome
orchestrator coordinates features, dependencies, integration, merge order and CI. A feature lead
coordinates its slices; each slice is bounded to one dedicated working session.
Workflow: multi-slice ask -> propose Telos -> approved feature and slice contracts ->
reviewed session setup -> execute the selected slice -> verify feature and outcome evidence.
Use the existing proposal/review flow; if the user already asked for Telos organization, do not add
another permission question. Proposal approval, session setup and execution retain their own host receipts.

Inspect exposed schemas before creating work. TelosCreateFeature saves a standalone feature with a
complete brief and criteria; no outcome wrapper or milestones are required.
TelosCreateChild can describe a feature under an outcome
or a slice under a feature. TelosCreateOutcome saves ordered milestones; inspect created children before
adding work. Milestone strings alone do not establish feature contracts, roles or working sessions.
Runtime kinds coordinator/outcome/work_item do not redefine the semantic levels or prove feature-lead
nesting. If a creator or assignment path is missing, preserve the brief and report the gap.
Prepare or recover sessions through supported reviewed Telos role setup. TelosStartSlice is limited to
an exact assigned lead and its selected eligible child; never infer new delegation authority from a title.
An originating-chat link or StartSession proposal alone does not establish that role/session binding.
If setup is unavailable, report item saved and session setup pending; do not claim the slice is ready.
Chat ready does not mean a command started or work completed. Recover the original attempt after uncertainty.

Example: "Two features are being worked on in parallel; set up a merge-queue orchestrator session
between the feature owners." Propose a shared outcome above the feature items with an independent
orchestrator session, and verify supported assignment/setup separately. Feature leads coordinate their
slice sessions; implementation, tests, review and PR preparation stay parallel, while actual merges are coordinated
sequentially. This does not authorize merges/deployment, pause all work or create another scheduler.
Independent sessions created from an existing session are the intended orchestration workflow, with tree
navigation for related work. This implies neither runtime nesting nor inherited tool/merge authority.
Creation provenance remains distinct from current responsibility. Arbitrary existing-chat attachment or
orchestrator handover requires a supported reviewed binding flow; do not rewrite private session data.
Preserve existing assignments, attempts and receipts; linking alone grants no permissions or execution.
`;

export function withTelosWorkflowInstructions(prompt: string): string {
  return prompt.includes(TELOS_WORKFLOW_INSTRUCTIONS)
    ? prompt
    : `${prompt}\n${TELOS_WORKFLOW_INSTRUCTIONS}`;
}
