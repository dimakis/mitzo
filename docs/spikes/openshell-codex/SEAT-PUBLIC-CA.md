# Public supervisor CA reads inside a seat

The supervisor supplies `SSL_CERT_FILE` pointing to
`/run/openshell-supervisor-ca/material/ca-bundle.crt` and `NODE_EXTRA_CA_CERTS`
pointing to `ca.crt` in the same directory. The seat launcher installed a second
Landlock layer that permitted `/etc` reads but neither of these `/run` files.
A physical probe in the disposable corrected-TLS fixture confirmed both files
were readable outside the attempt controller and failed with errno 13 inside it.
That probe made no inference request; its sandbox was deleted and controller
cleanup confirmed.

The launcher now adds `LANDLOCK_ACCESS_FS_READ_FILE` rules for these two exact
regular files. `O_NOFOLLOW` plus a regular-file check rejects certificate symlinks.
It grants no read-directory, write, truncate, delete or execute permissions there,
no private-key access, and no access to the rest of `/run`. Paths are constants,
not selected from environment variables. Missing optional files preserve offline
and older-image behavior. Existing supervisor/gateway rules remain an independent
restriction; this does not patch or replace them.

Run the physical regression explicitly:

```sh
sh docs/spikes/openshell-codex/seat-public-ca-smoke.sh
sh docs/spikes/openshell-codex/subscription-landlock-smoke.sh
```

The first script compiles the checked-out launcher with warnings treated as errors
in a disposable container, with `--network=none --pull=never` and the same pinned
local image used by the existing subscription smoke. It streams only source and
fake public/private markers, without mounting host paths or supplying credentials.
Before the fix, reading the fake bundle failed with `PermissionError: errno 13`.
Afterward, read and write seat modes both read the two public files while denying
certificate mutation, fake key and unrelated-file reads, directory listing,
file creation and a HOME symlink escape. It also rejects a certificate symlink
and checks startup when optional certificate files are absent. The existing
subscription physical Landlock smoke still passes.

This is source and offline kernel validation, not a successful live model run.
No existing gateway, runtime image or production attestation was changed. Building
this launcher into a new image changes its binary/image digest and requires fresh
reviewed image proof before attended runtime acceptance; previous recorded image
hashes are historical and must not be reused as proof for the new binary.
