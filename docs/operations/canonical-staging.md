# Canonical Mitzo staging

The configured macOS workstation has one regular staging app at
`http://mitzo-staging.localhost:3190`, managed by `com.mitzo.staging`.
Its private installation is `~/.local/share/mitzo-staging`. The separate hostname
keeps its host-only login cookie separate from production's localhost login.

Start a Mitzo session by reading this procedure and running:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging check
```

The command verifies source/tree cleanliness, compiled output, the dependency
fingerprint and the registered job's directory/listener. It reads current main
without updating the active release's remote refs. `safe` describes integrity and
runtime identity; `stale` means main has advanced. A stale stage can remain the
explicitly selected test baseline. Startup checks its pinned commit, tree, clean source and accepted-main ancestry; refreshing the cached main ref does not invalidate that baseline. `check --offline` does not verify main freshness.
A retained deployment lock marks the check unsafe even if the app is running.
There is no unattended upgrade or scheduled drift monitor.

## Prepare and plan an update

This first controller supports accepted main releases for the regular app.
Experimental branches, Symposium custodian enrollment and provider setup require
separate reviewed configuration; this command cannot adopt their ownership.
Use a full 40-character commit ID, not a moving branch name:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging prepare --commit TARGET_SHA
~/.local/share/mitzo-staging/bin/mitzo-staging deploy --commit TARGET_SHA --expected-current CURRENT_SHA
```

Preparation clones independent source from the public repository and builds it
while the current stage continues running. It reuses an independent copy of the
installed dependencies only when the package lock is byte-identical. A changed
lock requires separately provisioning audited dependencies; it never silently
substitutes packages or accepts toolchain licenses. Main must still match the
selected commit after the build. Preparation creates no app, provider or model turn.

Deployment defaults to a plan. The explicit apply form is:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging deploy --commit TARGET_SHA --expected-current CURRENT_SHA --apply
```

Before controlling the job, the CLI and its support modules must be identical to
those in the accepted candidate. This keeps a locally edited, unaccepted controller
from applying deployment. The controller reserves an exclusive private lock,
revalidates the exact requested candidate receipt, current release and original pinned PID/job/listener, then requests
SIGTERM through the staging service's existing launchd control handle. It does not
signal discovered PIDs or call production deployment scripts.

After the original app has stopped and port 3190 is free, it preserves an offline
workspace/state snapshot. It promotes the validated receipt and launcher, grants
one bounded start permit and starts the same stage service. Success requires the
new process directory/listener and HTTP readiness. The audit records the planned
and verified commits; secrets and provider transcripts are excluded.

A failed/uncertain shutdown, snapshot, promotion, start or verification keeps the
lock and evidence. Do not force-kill, remove locks, start a second service or
reuse a start permit. There is no automatic rollback: new code may have migrated
state, and a filesystem snapshot does not restore live native custody. Inspect the
exact operation and choose a separately reviewed recovery action.

## Current configuration and protection

App authentication, HOME, workspace, state, catalogs and dependencies are isolated.
Provider connections are not configured. Production credentials and `.env` files
must not be borrowed. The service starts on login and has no automatic crash restart.
Each successful controlled update changes only this service and its private root.

The two retained October continuity checkpoints and old gateways, containers,
volumes and directories are not disposable controller resources. They remain outside
this regular staging app. Staging cleanup or deployment never authorizes changes to
production, its service, data or provider configuration.

Global Codex guidance routes future local Mitzo sessions here. Repository AGENTS.md
and the always-applied Cursor rule provide the same routing after this change lands.
Existing sessions must reread the guidance; it is not a cross-chat broadcast or
provider-context adoption receipt. Real model tests require explicitly supported
Luna, with the exact model and charged account announced before execution.
