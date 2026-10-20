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

Accepted-main idle persistence release is shared by repository and ordinary
workspaces. Ordinary prepare, reserve and claim remain active until their asynchronous
readiness work settles. Validation retains its synchronous custody contract. Idle release refuses those operations
without cancellation or replacement. After release, every ordinary entrypoint
fails before readiness acquisition or private persistence access; reads cannot
lazily reopen custody. This adds no cleanup, deletion or task lifecycle operation.
