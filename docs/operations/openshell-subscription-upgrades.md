# OpenShell personal-subscription upgrade contract

Mitzo's personal ChatGPT path spans two separately deployed components. PR
[#487](https://github.com/dimakis/mitzo/pull/487) added Mitzo's broker-binding
enforcement and subscription runtime, but sign-in and token custody remain the
responsibility of a patched OpenShell gateway. Installing Mitzo alone is not a
complete rollout.

## Required gateway behavior

- The gateway exposes attended provider login for provider type
  `openai-codex-oauth`.
- The production provider is named `mitzo-personal-subscription` in workspace
  `default`.
- Refresh tokens stay gateway-owned; Mitzo stores only provider identity and
  never a `credentialRef` for this account type.
- Refresh status exposes safe operational metadata, including a non-secret
  generation/authorization epoch, expiry, and actionable failure state.
- A sandbox can call `https://inference.local/v1` without receiving credentials.
  OpenShell injects the current access token and required account metadata only
  on the bound upstream route.
- Direct or unbound credential-bearing routes fail closed.

The reviewed patch series originated at NVIDIA/OpenShell issue
[#2740](https://github.com/NVIDIA/OpenShell/issues/2740). Its converged public
review is [saariuslystoned/OpenShell PR #1](https://github.com/saariuslystoned/OpenShell/pull/1)
at `f8cbf77623559149e91c63385992e2acb9e8bda0`; the locally accepted follow-up
series ends at `820ccdcee2d871921c01cba1dfaf5d8e42c72d5e`. A production build must be
based on the intended upstream release plus the reviewed functional commits;
do not use either hash as a version-agnostic binary pin.

## Upgrade procedure

1. Record the current CLI, gateway, compute driver/supervisor, runtime image,
   provider profile, and patch commit. Capture metadata only—never auth data.
2. Build the patch on the exact target OpenShell release in an isolated state
   directory. If the release removed managed inference routing or
   `inference.local`, treat the work as an architecture migration and obtain a
   fresh review.
3. Run formatting, unit/integration tests, and isolated gateway acceptance.
4. Back up production configuration and prepare the previous executable/image
   as a rollback. Do not transplant the isolated credential database.
5. Deploy matched CLI/gateway/supervisor components. Reauthorize the provider
   through attended gateway login if necessary.
6. Run all smoke tests below. Roll back on any failure.

## Mandatory smoke tests

1. Gateway health reports the expected patched build and matching compute
   driver/supervisor version.
2. Provider login is available and refresh status reports a live generation,
   expiry, and no terminal recovery action.
3. Provider metadata exactly matches the name, type, and workspace above.
4. The brokered `inference.local` path completes a real model/tool turn from a
   credential-free sandbox and returns a unique marker.
5. A direct, non-brokered credential attempt is denied for the expected policy
   reason; DNS, TLS, or generic connectivity failures do not count.
6. A normal Mitzo subscription chat completes over SSE and returns its unique
   marker after a service restart.
7. Logs and captured artifacts contain no token, auth JSON, authorization
   header, or credential database content.

The isolated acceptance record that established this contract is maintained in
the rollout workspace as `outputs/personal-subscription-acceptance.md`.
