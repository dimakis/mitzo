# Canonical Symposium staging

The 6 October decision is to use one persistent staging environment for Symposium.
The existing canonical app at `http://mitzo-staging.localhost:3190` is the target;
new conversations create seats and their owned resources inside that environment,
not another staging backend or custodian. The private root is
`~/.local/share/mitzo-staging`. Production ports 3100/3101, configuration and state
are excluded. Retained October diagnostic owners are evidence, not this stage.

## Reviewable operator cut

The local transition cut layers the static support commit `54f3a887` and ordinary
controller commit `6e50e9af`. Neither local dependency nor this cut is claimed as
accepted main. No activation is performed by this document. The native registered
launcher, capacity-one registry writer, original-owner callbacks and no-force
custodian exit remain in a separate lifecycle cut. A built controller is distinct
from a physically qualified target; compilation and synthetic tests grant neither
custody nor provider readiness. See the
[transition split manifest](symposium-transition-split-manifest.json).

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

## Preparing the canonical service

After the exact detached release is reviewed, built and prepared as an owned
release, its plan uses these paths inside the existing private root:

- plan: `symposium/service/owned-release.json`
- host config: `symposium/settings/owned-host.json`
- registration: `symposium/settings/staging-registration.json`
- workspace: `symposium/workspace`; app HOME: `symposium/home`
- registry: `registry`, with capacity exactly one
- release: `releases/<12-character source commit>`

Run this from that verified release:

```sh
node scripts/prepare-staging-service.mjs \
  ~/.local/share/mitzo-staging/symposium/service/owned-release.json \
  ~/.local/share/mitzo-staging/symposium/settings/staging-registration.json \
  3190 --canonical --accepted-main-baseline ACCEPTED_BASELINE_SHA
```

Canonical preparation emits only `com.mitzo.staging`, private fresh app
credentials and a manually started plist. The launcher rechecks canonical paths,
registry capacity and loopback port before claiming any ownership. A changed
registration or launch intent prevents reuse. This command never installs the
plist, stops the existing service, authenticates a provider or launches a model.
The ordinary stage stays running until the reviewed original-control transition
is ready; do not bootstrap a second label alongside it.

Canonical owned-release integrity checks pin the exact detached commit, tree and
independently reviewed accepted-main baseline explicitly supplied with
`--accepted-main-baseline` and pinned in the plan, matching release.txt, clean tracked files and the
published source ref. The baseline must be in both the selected source and
accepted-main history. A later cached main ref does not invalidate unchanged
source; operators still check freshness separately. Other owned trials and
production retain their existing deployment guards. These source checks do not
replace exact-head CI/review or physical admission evidence.

The canonical app child uses staging-only unconfigured sidecar ports5191–5193
for Yapper, ContexGin and Centaur, and its own3190 app URL. Production defaults
are not inherited; any future sidecar enrollment needs separate staging setup.

Canonical plans are identified from their paths, independently of optional CLI
flags. Ordinary trial preparation and unregistered owned launch refuse those
plans. Prepare the owned bundle with --canonical after creating the capacity-one
registration; it omits the unregistered custodian plist. Only the registered
canonical launcher can start that plan. Removing --canonical never selects an
ordinary trial or bypasses its registry/port checks.

## Original-owner check and retirement

The registered canonical launcher records `original-owner.json` from the live
custodian callback. It includes the original parent and app child, their process
birth times, controller epoch, source and immutable-input identities. The recorder
cannot reopen a previous owner or adopt a record. A planned controller handoff
updates only through the original callback, preserving the parent identity.

After activation, run the selected release's controller:

```sh
node ~/.local/share/mitzo-staging/releases/SOURCE_PREFIX/scripts/symposium-staging.mjs check
```

This verifies pinned source, compiled/public inputs, the capacity-one registry,
original parent, exact app child/parent relationship, and the3190 listener.
Production listener PIDs are excluded. Check and drain never create registry
records or reconstruct native capability. Offline check leaves freshness unknown.
The ordinary controller continues to refuse this parent/child topology.

A retirement plan requires the exact identities printed by check:

```sh
node ~/.local/share/mitzo-staging/releases/SOURCE_PREFIX/scripts/symposium-staging.mjs drain \
  --source FULL_SOURCE_SHA --instance ORIGINAL_INSTANCE_ID --epoch CONTROLLER_EPOCH
```

Only adding `--apply` requests SIGTERM through the same `com.mitzo.staging` job.
The exclusive deployment lock is shared with ordinary staging operations. Before
control the script rechecks identities and unchanged evidence. Success requires
both processes and the3190 listener to disappear, plus the original registry's
retired state and matching native retirement receipt after the requested drain.
A stopped process alone is insufficient. Uncertain shutdown retains the lock and
evidence. No force escalation, automatic replacement, rollback or startup command
is included. The VM must stay running until native retirement is confirmed.

The owned check/drain controller never performs the initial transition or adopts
an old custodian. The separate initial-transition command below retains the
existing ordinary service's original control.

## Initial ordinary-to-owned transition

The initial transition is prepared and reviewed as code; this document does not
activate it. It depends on the original canonical ordinary controller's private
release receipt and installed service layout (the controller work in PR745).
It does not import that feature branch or claim its code has reached main.

Run from an independent built **controller** release prepared by the canonical
ordinary controller at accepted main. Its private `staging-release.json` receipt
qualifies its source/tree, complete compiled inventory and dependency fingerprint.
The separately prepared owned plan selects the independently reviewed app target.
Use full source identities for controller, target and existing ordinary app:

```sh
node scripts/symposium-staging-transition.mjs prepare \
  --commit TARGET_SHA --expected-current ORDINARY_SHA --controller-commit CONTROLLER_SHA \
  --accepted-main-baseline ACCEPTED_BASELINE_SHA
node scripts/symposium-staging-transition.mjs plan \
  --commit TARGET_SHA --expected-current ORDINARY_SHA --controller-commit CONTROLLER_SHA \
  --accepted-main-baseline ACCEPTED_BASELINE_SHA
```

Preparation creates one exclusive `symposium/service/transition.json` receipt. It
pins the accepted-controller qualification, old receipt, installed ordinary
controller/service files, original PID and birth,
release directory, prepared plan/configuration/operator/registration/plist hashes.
The private registry must be empty; launch intent, old owner records and preexisting
owner log targets refuse preparation. No native registrations or model calls are
created. Plan rereads these files and identities without changing launchd.

The explicit control command is:

```sh
node scripts/symposium-staging-transition.mjs apply \
  --commit TARGET_SHA --expected-current ORDINARY_SHA --controller-commit CONTROLLER_SHA \
  --accepted-main-baseline ACCEPTED_BASELINE_SHA
```

Apply requires the executing controller release to match the explicit
`CONTROLLER_SHA` and freshly fetched accepted main. Its HEAD/tree, clean tracked
source, unhidden index, public repository origin and accepted ancestry, complete
compiled artifact inventory and dependency fingerprint are checked. The private
ordinary-preparation receipt, controller script hashes, source tree and build and
dependency identities are pinned separately in the version-two transition intent
and rechecked under the shared lock immediately before control. Local aliases,
controller drift, missing receipts and an unaccepted controller refuse control.

`TARGET_SHA` may be a different independently reviewed published source. It remains
qualified by the owned plan's source/tree, build/runtime inputs and configuration
checks, its accepted-main baseline and all canonical static gates. There is no
exception flag and no substitution of target verification code for the executing
accepted controller. Exact-head CI and final independent review of the controller
and target, plus independently reviewed staging configuration, remain source
acceptance prerequisites outside this command.

This separation does not qualify the current feature controller as accepted main.
A narrow controller change including its owned-release verification dependencies
must first be reviewed and accepted on main, then independently prepared through
the ordinary exact-commit command to obtain its `staging-release.json`. The existing
feature stack need not be treated as accepted main. These commands do not clone,
build, adopt a service or make an activation exception to obtain that prerequisite.
Version-one transition intents cannot be reused; preserve them as evidence and
prepare a separately reviewed fresh transition without deleting uncertain state.

Apply reserves the same `service/deployment.lock` used by ordinary updates and
owned drain. It rechecks immutable inputs, accepted main, the original launchd
control path, PID/birth/release/listener and production listener exclusions before
SIGTERM through `gui/UID/com.mitzo.staging`. It requires the exact old PID, job PID
and3190 listener to disappear. A stopped ordinary process alone does not authorize
adopting another owner.

After confirmed exit, it copies only the ordinary workspace, state, HOME,
settings, bin and original service artifacts to `service/transitions/UUID`. The
existing originals and Symposium workspace/HOME/configuration/VM remain retained.
It installs the prepared plist under the same `com.mitzo.staging` identity with
KeepAlive and RunAtLoad false, removes the old stopped launchd registration,
bootstraps that identity and requests one start. Static qualification and production
exclusions are rechecked before bootstrap/start. There is no second label, backend,
VM stop, force kill, fallback credential source or automatic rollback.

The canonical wrapper's `bin/staging.mjs` becomes an owned-only router for check
and drain. It pins the source in `service/topology.json` and refuses ordinary
prepare/deploy/restart commands. The retained ordinary controller also fails its
original job/listener checks against a custodian parent/app topology; do not run
retained launchers directly. The transition verifies the original owner record,
private capacity-one registry, parent/app birth and relationship, exact source and
3190 listener, production exclusions and HTTP readiness before releasing its lock.
An attempted stop followed by any uncertainty retains the lock and audit evidence;
no replacement, retry or rollback is started. Inspect any partial preparation or
transition instead of deleting its intent or lock.

Canonical owned-bundle preparation also requires explicit `--canonical --accepted-main-baseline ACCEPTED_BASELINE_SHA` after the config, repository and plan-directory arguments. The baseline is selected independently of release.txt; canonical plans without that pin are refused. Canonical preparation emits no generic owned-custodian plist, and the generic launcher refuses canonical plans. The registered native target lifecycle remains a separate, missing qualification prerequisite.

Transition receipt checks reuse the ordinary controller dependency closure-v2 algorithm, including resolved workspace symlink payloads. Historical link-text-only receipts are refused; this source change neither migrates nor overwrites private evidence.

Before any ordinary service control, transition preparation requires the target’s `scripts/start-staging-custodian.mjs` to be a regular unaliased tracked file whose Git blob matches the plan source commit. The owned plan independently proves the published source HEAD/tree and the complete compiled/scripts build. The launcher digest is retained in the transition intent and rechecked before control. This operator checkout intentionally lacks the registered native launcher and refuses activation; a synthetic successful CLI fixture supplies an explicit target launcher and does not establish native readiness.
