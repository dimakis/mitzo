# New-chat failures after release replacement

## Confirmed findings

The deployed OpenShell declaration still selected a file in the prior release.
Its source-dependent contract did not match the running release. The loader
correctly refused that route; capability composition presented it as unavailable.
The declaration's target identity is independent of that deployment contract.
Read-only reconstruction from the prior accepted Git source confirmed that the
existing CLI bytes, image and selected stack still matched the original contract.
No model call, provider mutation or service restart was used for diagnosis.

The current Host Mac source contract and measured native binary pins validated.
Its exact phone-side refusal is not established by the screenshot. Separately,
offline regressions reproduce two concrete silent-failure defects: the ordinary
conversation render omitted its supplied send feedback, and command preparation,
authentication, scope and durable-queue refusals returned false without setting
an error. A simulated storage refusal preserves the request but previously showed
no explanation. These findings do not establish that the phone ran out of storage.

## Release boundary

The accepted release helper now includes enabled OpenShell even if every Local
route is disabled. It renews only an existing operator declaration. For a stale
v1 contract, it finds the declaring release receipt, verifies its commit and tree
against accepted Git history, reads the manifest/version as data from Git blobs,
and reconstructs the old contract against the currently measured CLI and selected
image/stack. It never imports old executable code. Only a matching old contract
and unchanged native protocol permit source-only renewal. The current loader then
validates the prepared declaration, authored policy and binary before the existing
atomic environment selection. Missing proof or changed binary, policy, stack or
protocol stops preparation without switching the environment or replacing the
service. New enrollment remains an explicit operator action.

This extends the existing release-time renewal and startup read-only validation;
it does not weaken runtime admission, enable disabled routes or allocate a sandbox.
Private selectors, accounts, target identity, gateway, workspace, binary pins and
history remain owned by their existing authorities. The old release is retained.

## Effects and safeguards

1. A source update changes deployment qualification. The release must renew all
   enabled declarations before service replacement, including OpenShell-only hosts.
2. Invalid qualification removes the route from usable capability inventory.
   Admission still fails closed; another account/environment is never substituted.
3. Invisible feedback makes a refusal look like a dead Send button. The existing
   status component now appears beside ordinary and new-chat composers, and local
   enqueue refusals have bounded, actionable messages without private error text.
4. Repeated taps and reloads can otherwise accumulate ambiguity or risk draft loss.
   A rejected enqueue neither dispatches nor consumes the draft. Existing pending
   commands retain their original identity; no automatic replacement/retry is added.
5. An unsafe deployment workaround could adopt changed binaries or strand history.
   Prior accepted-source proof preserves v1 pins, current validators qualify the
   candidate, and stable target identity preserves continuation ownership. Missing
   proof remains a deployment blocker, rather than an automatic reenrollment.

## Validation and UI design

Synthetic release fixtures cover cross-release OpenShell renewal, accepted-source
and tree proof, previous-file retention, idempotence, private modes, binary/policy/
stack drift and startup/deployment failure ordering. Tests never import production
configuration, execute a fixture CLI or make a model call.

The real store, durable outbox, ordinary conversation wrapper and composer run in
an intercepted browser fixture. Storage failure visibly retains text and an image,
makes no request, and a subsequent explicit send after storage recovery dispatches
once. WebKit and mobile/desktop Chromium pass in dark Mint/System and light
Teal/Georgia. The existing ChatStatusMessage and semantic tokens provide feedback;
chat-settings layout, palette, typography, touch targets and motion are unchanged.
Full production builds and the complete offline UI matrix remain CI gates.
