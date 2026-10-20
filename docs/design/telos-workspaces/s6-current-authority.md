# S6 current authority and retained attribution (CT11)

Parent `85e8444019a4ae4a`, slice `335551581dbf1e93`.

A durable execution binding records who originally received the exact task and
reviewed context. It remains readable after lead/worker replacement. Mutation
and command admission additionally require the latest delegated attempt and,
when explicitly assigned, the current worker conversation. An explicit retry
supersedes earlier attempts as soon as its intent commits; uncertain allocation
cannot leave both attempts authorized. Reassigning the same conversation does
not rewrite its immutable task/context binding.

Changing the outcome lead changes subsequent delegation/control routing. It does
not revoke an already allocated worker or rewrite that worker's source lead.
The existing current-lead guard rejects new delegation by the retired lead.
A late task completion from a replaced worker is rejected before task mutation;
its original conversation, task mapping, sources and retained output remain.

The ordinary command owner, TaskOrchestrator and task-tool callback guard share
`assertTelosWorkExecutionAuthority`. Unbound ordinary chats remain lazy and do
not open Telos. This change adds no execution, scheduler or model call.

Test-first evidence: the new restart/replacement test failed because the former
worker could still resolve command authority. The focused store/command/callback
regressions then passed (30 tests, one worker, 1 GiB Node heap). This is partial
S6 evidence: CT10 brief adoption, CT12 scoped holds and accepted S5b integration
remain outstanding. It makes no UI or live-runtime acceptance claim.
