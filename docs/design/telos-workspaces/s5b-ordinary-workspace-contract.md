# Ordinary non-Git workspace custody

S5b follows accepted S5a `634048b1c7309a411dcfbf39dd2ae4e0308bdcfb`.
The shared workspace selector remains either a repository preparation or an
ordinary preparation reference. This increment supplies the ordinary private
custody provider under the existing `RepositoryWorkspaces` application owner.
It reuses that owner's SQLite connection and allocation-operation mapping.
Session preparation, commands, tasks and artifacts continue to belong to their
existing owners; the directory provider has no scheduler or provider port.

The new explicit `OrdinaryWorkspaceSettingsSchema` carries:

```ts
{
  version: 2,
  binding: SessionRuntimeBindingV2,
  selection: OrdinaryLocalCommandSelection,
  workspace: { kind: 'ordinary', preparationId: string }
}
```

This is selection intent. The host resolves and rechecks current account,
credential, runtime and model readiness through the existing preparation
authority. Initial supported custody is ordinary local Codex with an
`openai-codex` account; other targets or providers receive an unsupported-isolation
reason before credential acquisition or allocation. A configured target alone
does not establish an implemented directory-isolation capability.

Capabilities are server-derived: ordinary conversation, writable files, retained
artifacts and task execution. A trusted operation can require capabilities and
thereby narrow admission. It cannot grant a missing capability. Git/repository
requirements are refused before the allocation journal. A preparation grants
neither public filesystem-path selection nor authority to use an account.

Legacy strict `CollaborationSettingsSchema` and repository preparation receipts
remain unchanged. New ordinary settings cannot enter that legacy schema, and
cannot carry a repository ID, caller path, readiness assertion or capability
grant. New role, session receipt and command-admission consumers require explicit
versioned integration; they are not enrolled by this custody increment.

Each allocation operation retains one independent workspace and conversation ID,
separate from the reusable preparation ID. Exact concurrent operations and
restart recover the same reservation; changed settings under the same operation
fail without replacement. Reservation does not create a directory or command.
The first explicit materialization journals `claiming` before touching its exact
private destination. A successful claim retains the canonical parent and task
directory device/inode identities. Replays preserve legitimate edited files.
Replaced or symlinked directories fail closed and are not removed or recreated.

As with existing repository custody, interrupted materialization retains the
original claim as uncertain. A later request cannot report readiness, allocate a
replacement or delete its files. Inventory/recovery can still identify the exact
original workspace and conversation. This increment introduces no cleanup path.
Future cleanup must retain the existing task-binding/nonterminal/pending-review
fences, including historical null session references and unavailable inventory.

The offline custody fixture creates private temporary non-Git storage and fakes
only the account/runtime readiness boundary. It does not reuse the Git-based
joining or native-runtime fixtures. Repository authority, acquisition and
verification ports are forbidden in that fixture. The internal-token module is
intercepted before transitive imports. Separate existing repository tests retain
Git-based pinning/custody regression coverage.

Evidence starts with six missing-API contract failures. The first implementation
run exposed an invalid synthetic account fixture missing its required label;
that diagnostic is retained separately. Subsequent adversarial failures reached
account-scope, provider and replaced-directory replay boundaries. A specific
post-creation readiness fault proves uncertain custody before the fail-closed
repair. Nine custody and three protocol contracts now pass, alongside nineteen
existing repository cases in the focused thirty-one-case run. Package/scoped
server types and targeted lint pass. Current-head CI and trusted review remain
required before source acceptance.

CT07–CT09 stay open until ordinary role preparation, real command admission,
exact child/task delegation and the complete non-code output/review/completion
journey are integrated. Browser evidence must include ordinary resources, drafts,
navigation and reattach. No hidden Git fixture can qualify those journeys. Code
acceptance, complete offline integration, owning UI acceptance and live runtime
qualification remain separate. No model, live target, staging or deployment test
is authorized by this work.

## Versioned ordinary session journal

A separate strict V2 preparation receipt retains `workspaceKind: 'ordinary'`, the
allocated workspace/session identities, original V2 settings and the existing
allocation-operation fingerprint. It uses the same EventStore preparation table.
The V1 schema and its normalized JSON stay unchanged; V1 getters cannot project
an ordinary receipt as a repository. New explicit ordinary getters serve this
kind. These private ports require the caller's existing authorization, readiness,
profile and directory-owner qualifications; a metadata receipt grants none.

Session metadata stores `ordinaryWorkspaceId` separately and exclusively from
`repositoryWorkspaceId`. Runtime-bound kind, identity and cwd cannot be replaced
or cleared. New ordinary enrollment is limited to local Codex/openai-codex.
Exact restart/replay checks the original metadata, account and settings. The
explicit first command consumes that same preparation in the existing global
command/send/admission transaction. No implicit command, native thread or provider
turn is created by preparation.

Existing local command receipts already carry a generic workspace identity and
cwd. Their original wire shape is retained, with durable session-kind checks.
Unprepared ordinary metadata and unsupported adapters cannot enter that ledger.
Legacy joining allocation refuses an ordinary command rather than manufacturing
a repository identity from its generic ID. A real-owner negative integration
case demonstrates that fence; synthetic capacity is supplied only at the existing
trusted compiler port, with no model/native call.

Seven ordinary session-journal cases and sixty existing preparation/runtime/
metadata cases pass in the focused 67-case run. Native owned-runtime, public
role/command wrappers and frontend adoption remain separate integrations, with
CT07–CT09 still open.

## Explicit V2 role and exact-child adapters

New strict `TelosOrdinaryWorkRoleSetupInputSchema` and
`TelosOrdinaryWorkDelegationInputSchema` require outer `version: 2` and ordinary
V2 settings. Existing repository V1 schemas and getters remain exclusive.
Private adapters reuse the existing canonical role/rejection/delegation journals,
allocation operation, EventStore preparation, TaskStore mapping and role workflow.

Actual private account/model/thinking, published profile/tool route, runtime and
capability qualification precede a new V2 role or child allocation intent. Thinking
is rechecked through the authoritative account/model owner before and after
readiness waits. Original proof, settings and command fingerprints are retained.
Unsupported requirements fail before allocating; declared requirements only narrow
the server capability set.

One selected child receives an independent ordinary workspace, chat and task.
Exact and distinct-request default-start duplicates recover the canonical attempt;
owner restart and lost preparation responses recover its original IDs. Explicit
retry names its predecessor and preserves earlier workers, retained output and
history. Hidden original sessions and unavailable task inventory fail closed.
No provider turn starts during role or delegation setup. No ordinary cleanup or
second scheduler is introduced.

These private adapters remain dependent, unaccepted source. Public HTTP/client/UI
adoption and the complete CT07–CT09 journeys are still separate requirements.
