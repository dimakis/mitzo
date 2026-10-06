# Canonical Symposium staging

The 6 October decision is to use one persistent staging environment for Symposium.
The existing canonical app at `http://mitzo-staging.localhost:3190` is the target;
new conversations create seats and their owned resources inside that environment,
not another staging backend or custodian. The private root is
`~/.local/share/mitzo-staging`. Production ports 3100/3101, configuration and state
are excluded. Retained October diagnostic owners are evidence, not this stage.

## Current qualification

The current service runs accepted ordinary main with providers disabled. It is not
Symposium-ready. The integration candidate includes the conversation UI, custom
profiles, explicit reviewer/context selection, workflow limits and retained owner
handoff. Synthetic tests and historical Luna turns do not establish current full
workflow acceptance. The earlier planning reset is preserved; the user has now
asked to resume implementation toward this singleton and usable Symposium.

The first product slice remains: work in one conversation, add an independently
configured read-only reviewer with selected context, stream attributed results,
and explicitly stop. Keep the broader review/fix/acceptance and recovery outcomes.

## Activation contract

1. Reconcile the existing integration candidate with current main; qualify the
   exact head with CI and final independent review. Resolve the oversized-review
   prerequisite without accepting a partial diff as complete review.
2. Prepare an independent built release and a fresh canonical owned-host plan.
   Use staging-only private app authentication, HOME, databases, gateway identity,
   runtime pins, policy and provider references. The registry has capacity one and
   one fixed private path outside release/state inputs. Do not import old owner
   registrations, uncertain native operations, or production credentials.
3. Use one `com.mitzo.staging` service identity and port 3190. Transition the
   ordinary app only through its original service control after source and static
   configuration gates pass. The new custodian retains ownership while its app
   child serves the same URL; KeepAlive stays false. Do not install a second job
   with a generated trial label alongside the canonical service.
4. Extend the controller's ownership checks before this transition. Its current
   ordinary-app mode assumes the launchd PID is the listener. A Symposium parent
   and app child require both identities and a retained original-owner drain
   receipt. The current controller must refuse that topology, not adopt it or
   treat a successor PID as the original owner. Do not use the ordinary restart
   command to replace an active custodian.
5. Configure a fresh staging provider connection through the supported account
   path. Confirm the available Luna model without inference. Before real tests,
   announce the exact supported Luna model and charged account. Never reuse old
   catalog-operation IDs or silently substitute another model.
6. Verify the product slice in the supported app, then review/fix, delta review,
   meaningful acceptance, stop/resume and device behavior. Record exact source,
   artifact, account/model and operation identities and bounded outcomes. Missing
   custody, readiness or terminal proof remains an open gate.

No activation, provider sign-in or model test is performed by this document.
Neither preparation nor review grants production deployment authority. Custodian
loss and uncertain drains preserve the registry slot and evidence; no forced
restart, old launch-intent deletion, automatic rollback or parallel replacement.

See the [product acceptance checklist](../features/symposium-integrated-acceptance.md)
and [owned service preparation](symposium-staging-lifecycle.md).
