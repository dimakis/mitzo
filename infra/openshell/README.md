# Mitzo + OpenShell production bundle

Lifecycle retention is opt-in. Idle stop defaults to 30 minutes, retention to seven days (five-day minimum), and reconciliation to five minutes. Automatic deletion also requires authenticated operator consent and a verified checkpoint; it is not enabled merely by retention configuration. Live sandbox cleanup remains separately untested; local Codex checkpoint round-trip coverage uses an isolated loopback provider.

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
new sandboxes according to the pinned provider policy, while their provider
profiles remain the independent network and credential policy boundary. GitHub
is attached automatically. Google Workspace is grantable from a chat through a
Mitzo approval card and then remains attached to that conversation's retained
sandbox. The built-in GitHub profile is intentionally read-only; authenticated
mutations require a separate Mitzo-approved executor.
The Google Workspace profile follows the same split: sandbox-native Drive,
Docs, Calendar, Gmail, and Sheets reads are available, while creates, updates,
sends, and deletes remain unavailable until routed through structured approval
tools. Gmail and Sheets use their dedicated API hosts; allowing only
`www.googleapis.com` does not make those services reachable through the
OpenShell tunnel.

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

1. Merge the runtime changes so the clean Mitzo and MGMT checkouts are both at
   current `origin/main`.
2. Stage the immutable image, prepared seed, synchronized stack lock and
   environment example, and focused verification with one command:

   ```bash
   ./scripts/stage-openshell-release.sh \
     /absolute/path/to/clean/mgmt \
     /absolute/path/to/new/immutable-seed
   ```

   This command never deploys. It fails closed on dirty or stale checkouts,
   existing artifact names, image provenance drift, a legacy todo skill in the
   seed, or failed tests. Review and merge its generated lock diff.
3. If provider or account bindings changed, import the reviewed profiles and
   update the ignored account-profile file. Otherwise retain the already pinned
   gateway state. Every OpenAI API account must name its sandbox provider; every
   personal subscription account must use a complete `openai-codex-oauth`
   provider/grant binding and must not retain a host `credentialRef`.
4. Review and merge the generated stack-lock diff after CI and code review pass.
5. Create and activate the immutable release from current `origin/main` with
   `MITZO_RELEASE_SEED` set to the new
   prepared seed's `mgmt` directory. The release command validates the sibling
   `baseline.json`, rewrites only the release copy of `.env`, and runs
   `verify-openshell-production.mjs` against that coherent release before it
   becomes active. It does not modify or preflight against the canonical
   runtime environment, whose old seed intentionally remains paired with the
   old stack lock until the release is ready.
6. Verify launchd, the HTTPS endpoint, retained sandboxes, and the active
   release's image/seed/lock wiring. Run a Luna-backed conversation canary only
   when the release changes model or provider execution behavior.

## Rollback

Keep the previous Git commit, runtime image, seed, account profile, and stack
lock together as one release. Rollback changes all five references as a unit,
runs the preflight, and only then restarts Mitzo. Existing sandboxes are retained;
the rollback must not delete them. If provider-profile policy composition itself
must be rolled back, disable OpenShell routing in Mitzo first, then remove the
gateway-global `providers_v2_enabled` setting.

## Gateway state, backup, and upgrades

Treat the gateway database, its credential-encryption key, client trust state,
Podman machine storage, and the release lock as one recoverable set. On the
Homebrew macOS installation used for production, the relevant paths are:

- `~/.local/state/openshell/gateway/openshell.db`
- `~/.local/state/openshell/gateway/credentials/`
- `~/.local/state/openshell/homebrew/tls/`
- `~/.config/openshell/`
- `~/.config/containers/podman/machine/applehv/`
- `~/.local/share/containers/podman/machine/applehv/podman-machine-default-arm64.raw`

The SQLite database currently uses delete journaling. A release backup must be
a cold snapshot: quiesce Mitzo, stop the OpenShell launch service, stop the
Podman machine, copy the paths above plus this stack lock and the active account
profile, and then restart the old stack. Validate the copied database with
`PRAGMA integrity_check` before declaring the snapshot usable. The Podman raw
disk contains retained sandbox workspaces and locally built images; a database-
only backup does not preserve them.

The backup contains the key that decrypts provider credentials and therefore
has the security value of the credentials themselves. Store it only on
encrypted storage with owner-only permissions. Never commit it, upload it as a
CI artifact, or print provider material into a logical inventory.

For an upgrade, preserve the old Homebrew gateway binary/version, Podman driver
version, runtime image, seed, account profile, policy, and cold snapshot. Upgrade
the gateway and driver as a matched pair, run the production preflight, and only
then resume Mitzo. If startup or validation fails, stop the new processes and
restore the complete matched snapshot before starting the old binaries. Never
run an older gateway against a database that a newer gateway may have migrated.

## Current deployment

The production gateway uses the matched OpenShell downstream release
`v0.0.116-mitzo.3` for the CLI, gateway, and Podman driver. It has the canonical,
encrypted `google-workspace` and `github` service providers plus the bound
`mitzo-personal-subscription` OAuth provider. Preserve this downstream release
and its protobuf compatibility invariant during upgrades; follow
`docs/operations/openshell-subscription-upgrades.md` and the always-applied
`.cursor/rules/openshell-subscription-upgrades.mdc` rule before changing any
OpenShell component.
