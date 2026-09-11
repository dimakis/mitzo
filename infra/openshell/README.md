# Mitzo + OpenShell production bundle

This directory is the non-secret release contract for the production-shaped
Mitzo/OpenShell stack. It does not copy credentials into the repository or a
sandbox.

## Stack boundary

The stack is intentionally split into independently managed layers:

1. macOS `launchd` starts the Homebrew OpenShell gateway
   (`sh.brew.openshell`) and Mitzo (`com.mitzo.server`).
2. OpenShell uses its rootless Podman driver to create one sandbox per Mitzo
   conversation.
3. All conversations share one immutable management runtime image. Specialized
   images are added only when their dependency set is materially different.
4. A reviewed MGMT seed initializes each new sandbox at
   `/sandbox/workspaces/mgmt`; retained sandboxes keep their own workspace.
5. Account/inference providers and service providers are attached per sandbox.
   Real credentials remain encrypted in the gateway and are represented inside
   the sandbox by policy-bound placeholders.
6. Mitzo remains the trusted control plane for account selection, durable
   conversation state, approvals, queueing, and recovery.

The shared runtime is verified to contain Codex, GWS, and GitHub CLI. The
production service-provider contract attaches Google Workspace and GitHub to
new sandboxes, while their provider profiles remain the independent network and
credential policy boundary. The built-in GitHub profile is intentionally
read-only; authenticated mutations require a separate Mitzo-approved executor.

The OpenShell gateway is not placed inside `docker-compose.yml`: it owns the
Podman sandbox lifecycle and its mTLS/control-plane state. The existing Compose
file remains the optional observability stack.

## Files

- `production-stack.lock.json` pins the gateway and driver versions, runtime
  image digest and provenance, policy hash, global feature settings, and service
  provider contract.
- `production.env.example` contains the non-secret Mitzo runtime wiring. Copy
  these keys into the real ignored `.env` and replace absolute paths.
- `account-profiles.example.json` shows the work-API and brokered personal
  subscription bindings. Store the real file outside the repository with mode
  `0600`.
- `scripts/verify-openshell-production.mjs` verifies the entire contract before
  `scripts/start.sh` or `scripts/deploy.sh` starts production Mitzo.

## Release workflow

1. Merge the runtime changes and build a uniquely tagged image with
   `docs/spikes/openshell-codex/build-mgmt-runtime.sh`. The builder requires an
   immutable base digest and labels the image with the Mitzo commit, MGMT
   commit, and base image.
2. Prepare a fresh seed with
   `docs/spikes/openshell-codex/prepare-mgmt-seed.sh`. Never point production at
   the live host MGMT checkout.
3. Import/update reviewed provider profiles, configure gateway-owned credential
   refresh, and set `providers_v2_enabled=true` globally.
4. Populate the ignored account-profile file. Every OpenAI API account must name
   its sandbox provider. Every personal subscription account must use a complete
   `openai-codex-oauth` provider/grant binding and must not retain a host
   `credentialRef`.
5. Update the stack lock with the actual image digest and policy hash, then run:

   ```bash
   node scripts/verify-openshell-production.mjs .env
   ```

6. Run a production-shaped controller on a non-production port and create a
   fresh conversation. After the normal chat, cancellation, retained recovery,
   and bounded provider checks pass, deploy through the existing launchd flow.

## Rollback

Keep the previous Git commit, runtime image, seed, account profile, and stack
lock together as one release. Rollback changes all five references as a unit,
runs the preflight, and only then restarts Mitzo. Existing sandboxes are retained;
the rollback must not delete them. If provider-profile policy composition itself
must be rolled back, disable OpenShell routing in Mitzo first, then remove the
gateway-global `providers_v2_enabled` setting.

## Current limitation

The default gateway currently has the canonical, encrypted `google-workspace`
provider and a working OpenAI API provider. The personal ChatGPT OAuth provider
used for live acceptance was isolated from the default gateway. A production
personal-subscription profile must not be enabled until that broker provider and
its active grant are deliberately provisioned on the default gateway.
