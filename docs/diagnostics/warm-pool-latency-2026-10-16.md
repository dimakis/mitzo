# Warm-pool first-send latency

An authorized production benchmark at accepted Mitzo `325041f01cdb` used five
serial cold/warm pairs with Work OpenAI API, `gpt-5.6-luna`, low reasoning, the same
short text-only prompt, runtime image and enforced 2-CPU/4-GiB limits. Each warm
sample verified the exact durable physical claim of its provider-neutral spare.
No tools were requested or used. Staging was not used.

| Median phase                   |    Cold |    Warm |
| ------------------------------ | ------: | ------: |
| Send to first visible text     | 10.45 s | 21.18 s |
| Native initialize RPC          |  0.29 s | 10.52 s |
| Send to model dispatch         |  9.37 s | 19.92 s |
| Model dispatch to first output |  1.27 s |  1.23 s |

First visible text ranged from 10.23–11.26 s cold and 20.67–21.95 s warm.
Spare preparation took 3.26 s median and is excluded from warm-send latency.
These are five pairs in fixed cold-then-warm order, not a load qualification.
The original production environment and disabled pool settings were restored;
benchmark conversation, physical ownership and operation records were retained.

The warm initialization spans consistently match the existing ten-second retry
after a missing provider environment. The supervisor refreshes provider snapshots
periodically; attaching a provider in the gateway does not itself prove that the
actual native exec shell has received its environment. The application must
continue to verify that shell. Shorter bounded probes avoid sleeping an entire
polling period after readiness becomes available. Prompt supervisor propagation
is a distinct runtime responsibility; these probes do not force a refresh.

Warm binding also selected fresh published knowledge and discarded that selection.
Its first turn reconciled it again (1.74 s median), whereas cold starts reused
their exact initial command selection. New claim admission now freezes the fresh
seed only after a neutral physical candidate is verified and durably assigned.
After final physical/account checks, its first turn can consume that command's
selection once through the existing identity-bound receipt. Earlier warmup
selections, external seeds, retained/recovering claims, another command, failed
or cancelled adoption cannot use the receipt. Normal host/runtime/remote integrity
and provider acknowledgement remain required.

Both changes have offline regression coverage. They are not post-fix production
measurements. Any accepted source activation and repeat benchmark need their
normal explicit production action and supported Luna/account selection.

## Mitzo-only qualification first

The application changes work with the existing pinned OpenShell supervisor.
Their first qualification needs a Mitzo application release, with the existing
gateway, CLI, supervisor image and credential configuration. This change adds no
credential migration and does not change sandbox account or ownership rules.

Shorter retries remove avoidable sleeping after credentials become available;
they do not accelerate the supervisor's periodic refresh. A healthy supervisor
may still need its next polling cycle before a new shell has the attached
provider. Offline coverage includes successful initialization when that refresh
takes ten seconds, as well as cancellation and bounded failure.

The separate supervisor wake-up patch in `dimakis/OpenShell` PR #4 is an optional,
deferred optimization. It changes in-memory refresh signaling, not persisted
credential formats or the credential protocol. Adopting its supervisor image
would still be a separate runtime rollout. First measure the application change
with the existing image; consider that rollout only if remaining provider-refresh
latency warrants it. The baseline above cannot establish the resulting speedup.
