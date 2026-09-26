# Isolated Symposium runtime image

`Dockerfile.symposium-seat-probe` now builds both the Landlock seat launcher and
native attempt controller from source. The controller source was recovered from
the retained build layer of the disposable `subreaper-v9-20260925` image, then
updated to set the workspace cwd, bound cancel-client reads, and ignore SIGPIPE
in the owner (the child restores the default disposition).

The controller admits one claim per socket, becomes a Linux child subreaper,
launches the command through Landlock, and records the exact claim's terminal
proof only after `waitpid` reports `ECHILD`. Natural primary exit also terminates
adopted descendants. Unknown claims and reused completed claims fail closed.
It must run inside the dedicated OpenShell sandbox; it is not a replacement for
OpenShell process/syscall and network policy. An owner crash produces no proof
and requires reconciliation rather than an inferred release.

Build with an immutable locally available base image ID, no network, and no pull:

```sh
podman build --network=none --pull=never \
  --build-arg OPENSHELL_BASE_IMAGE=0138f7b10c4f306a07b4ebda068c4b7c18f72eba127b8f60a152d3f3fa6b11d8 \
  -f docs/spikes/openshell-codex/Dockerfile.symposium-seat-probe \
  -t localhost/mitzo-symposium-seat-runtime:source-20260926 \
  docs/spikes/openshell-codex
```

Validated on 2026-09-26 in disposable network-disabled Podman containers:

- `symposium-seat-landlock-canary.sh`: own HOME access; peer HOME, symlink,
  `/proc`, global temp and reviewer workspace writes denied; writer succeeds.
- `symposium-claude-stream-canary.sh`: fixture stream and natural/cancel proofs.
- `symposium-codex-controller-canary.sh`: real Codex initialize only, no model.
- `symposium-controller-canary.py`: cwd, exact repeatable proofs, unknown/replay
  rejection, detached descendant reaping, explicit cancellation.

Run shell canaries by piping the file into `podman run --rm -i --network none
--entrypoint /bin/sh IMAGE`; run the Python canary with `/usr/bin/python3` as the
entrypoint. These checks do not access credentials or call any model.

Runtime image ID: `c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d`.
Podman manifest digest: `sha256:d00a366614f1926d7159a5290818418b041167295ba2e93692ce47a38e06448f`.
Registry import can change manifest representation; inspect the final registry
and containerd identities rather than treating them as this digest.

| Installed artifact                                 | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `/usr/local/bin/symposium-attempt-controller`      | `d9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209` |
| `/usr/local/bin/symposium-seat-landlock`           | `bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d` |
| `/usr/local/bin/symposium-subscription-app-server` | `ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb` |

Codex is `0.153.4`; Claude Code is `2.1.156`. Both private controller and seat
roots are mode 0700, owned by sandbox:sandbox. No production gateway was changed.
