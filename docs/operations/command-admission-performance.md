# Codex command admission performance

OpenShell turns retain fresh account, provider-policy, physical-runtime and knowledge
validation. The retained-runtime migration observation and subsequent provider
preparation are separate authority boundaries. A successful earlier observation is
not a cache entry for the next boundary or command.

Within the existing lifecycle reservation, saved agent-context validation still
precedes knowledge adoption and task inventory. Knowledge adoption and the fixed,
read-only task-capability inventory now run concurrently. The inventory checks
entrypoint presence and does not execute workspace scripts, inspect credentials or
write task/publication state. Both operations must settle before the reservation
can be released, including failure or cancellation. Knowledge failures retain
precedence when both fail. The final owner check still precedes context delivery;
adoption is recorded only after the provider accepts the exact context.

With tracing enabled, inspect these fixed span names under the send trace:

| Span                                   | Boundary                                                             |
| -------------------------------------- | -------------------------------------------------------------------- |
| `codex.admission.lifecycle_wait`       | Waiting for the existing lifecycle coordinator to admit work         |
| `codex.admission.retained_migration`   | Retained-runtime migration and its fresh contract/image observations |
| `codex.admission.provider_environment` | Fresh provider contract and required environment preparation         |
| `codex.admission.agent_context`        | Saved agent-context runtime verification, when selected              |
| `codex.admission.knowledge`            | Fresh knowledge selection, verification, delivery and compilation    |
| `codex.admission.task_capabilities`    | Fixed read-only inventory of task entrypoint presence                |

Existing `knowledge.*` spans provide more detail inside knowledge preparation.
Admission spans record status without error messages, exception details, prompts,
paths, account identifiers or provider secrets.

The offline regression blocks knowledge and inventory independently to prove
parallel starts and lifecycle ownership through both successful and failed work.
This establishes a critical path of the slower operation rather than their sum;
it does not establish a production latency reduction. After deployment, compare
warm sends for the same route and report admission, provider dispatch and first
output separately. Do not infer provider generation speed from HTTP receipt time.
