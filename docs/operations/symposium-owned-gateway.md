# Dedicated upstream gateway custody

`OwnedSymposiumGateway` starts an isolated gateway; it never adopts an existing
PID or reads a boolean capability receipt. Production admission remains a
separate gate requiring physical image/controller, volume, provider, account,
and per-seat proofs. The current development build is upstream
`854b2370b` (`0.0.117-dev.292+g854b2370b`).

The launcher copies digest-pinned gateway and CLI executables into a newly
created private directory, generates a fixed schema-v2 configuration, replays
its exact argv through `config preflight -- --config PATH`, and launches the
same executable/configuration with a scrubbed environment. Local `lsof` must
prove the live child owns the exact listener. Every custody check revalidates
that child, the listener, and hashes, modes, and ownership of the executable,
configuration, certificate, key, and gateway metadata snapshots. It cannot
reattach after a process restart. Interrupted state is retained for operator
reconciliation, never represented as a continuing owned capability.

## Management authentication

The upstream Podman driver requires a complete guest TLS CA/cert/key bundle
when gateway TLS is enabled. Enabling mTLS **user** authentication with that
bundle would let its client certificate authenticate a user when presented
without a sandbox JWT. Therefore the owned configuration explicitly disables
mTLS user mapping and unauthenticated users and enables OIDC for management.
Guest certificates authenticate transport only; sandbox JWTs retain their
upstream scoped authorization.

`SymposiumHostIssuer` creates a fresh RSA signing key in host process memory.
Its HTTPS worker binds numeric loopback and serves only discovery and public
JWKS; it exposes no login or token-minting endpoint. Its key is distinct from
the gateway's sandbox JWT signing key. The management JWT has a fixed issuer,
audience, subject and administrative role, expires after five minutes, and is
refreshed every minute into the documented private upstream CLI token cache.
The worker avoids deadlock while the host runs synchronous upstream probes.
The gateway receives a frozen bundle combining reviewed public system roots
with the dedicated issuer CA via `SSL_CERT_FILE`, preserving provider HTTPS
verification without ambient trust or environment overrides. The CLI receives a separate fixed environment with
only HOME, PATH and XDG paths and uses the named gateway's frozen OIDC metadata.

Issuer loss stops the gateway and invalidates custody. A different issuer or
new launch cannot revive the old capability. Token-cache replacement, expiry,
configuration drift or a different listener PID fail custody checks. Raw
management JWTs and issuer private keys must never enter sandbox inputs,
artifacts, logs, attestation JSON or route persistence. Certificate option names
`managementCert`/`managementKey` describe CLI transport files only; under this
configuration they confer no management authorization without the OIDC JWT.

The threat model trusts the host owner and root. It does not claim to protect
host-held signing keys from malicious same-UID code. The tested boundary is
that a sandbox/guest client certificate does not confer provider-management
rights, and model output or persisted receipts cannot fabricate live custody.

## Verification status

On 2026-09-26 an isolated local gateway successfully started with the pinned
upstream binary, TLS, Podman, sandbox JWT configuration, and HTTPS host issuer.
The real CLI reported the selected gateway healthy and accepted host OIDC
provider inventory. An isolated CLI with only the guest transport certificate
was rejected with `missing authorization header`; an altered bearer signature
was rejected with `InvalidSignature`. No real provider credentials or model
calls were involved. These results do not by themselves authorize production
account use or prove filesystem/seat isolation; those need separate canaries.

The supervised launcher must remain alive while using this capability. To
install a production host, create the gateway and compose its live verifier
with the separate image/controller, provider, volume and account proof
implementations, then invoke the application's host installer. Do not load the
no-model canary's route JSON as a trusted host capability.

### Actual no-model artifact and native transport checks

The isolated `symposium-live` workspace used workload image ID
`c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d`,
upstream sandbox image ID
`ea1fa3016afc3029d5cef331a92f3fb1383f03799221aec920248d06f4aba1dd`,
and upstream supervisor binary packaged with the public CA in image ID
`8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937`.
No private issuer key or management JWT was copied into any image or workload.

Both writer and reviewer reached `Ready` / `ConfigurationAccepted` using an
explicit policy with `network_policies: {}`. Podman inspection independently
showed the same named artifact volume at `/sandbox/symposium-artifacts` with
writer `RW:true` and reviewer `RW:false`. A host initializer assigned volume
ownership to the observed sandbox UID/GID 998; writer wrote a marker, reviewer
read it, and reviewer creation of a file failed with `Read-only file system`.

The repository's `symposium-codex-controller-canary.sh` ran successfully through
both upstream gRPC exec and the application's exact
`openShellSshArgvProcessSpec` SSH route with the private named gateway. It sent
only Codex `initialize`/`initialized` and obtained the controller's terminal
cancel proof. It did not request inference. Codex reported its bundled
bubblewrap fallback because no standalone bubblewrap was installed; initialize
still succeeded, and a full turn was not claimed by this canary.

An actual supervisor JWT, handled only by the host negative-test client, was
rejected by provider management with `sandbox principals may not call this
method`; the temporary token file was then deleted. The supervisor's scoped
JWT and transport certificate therefore did not admit provider inventory,
while the host OIDC management token did.

Public OpenAI discovery was fetched without credentials using the combined
public-system-plus-issuer CA bundle and returned HTTPS 200. The earlier
no-model gateway process used the initial dedicated-only CA bundle; future
bootstrap must use the corrected combined bundle before real provider auth.

Cleanup completed after the checks: the gateway reported no sandboxes, Podman
reported no physical containers for the isolated workspace, and the exact
canary volume and network were removed. The owned launcher, HTTPS issuer
worker, and gateway were stopped and the gateway listener was confirmed absent.
Certificates/configuration, reports and the reviewed images were retained for
the next explicit bootstrap; the completed canary route is not a live custody
capability.

## Explicit owned-native capability contract

`openshell-v0.1-owned-native-seats` is separate from the unchanged legacy
`openshell-v0.1-openai-seat` contract. The owned schema pins the exact tested
upstream development version, CLI/gateway byte digests, workload manifest and
image ID, supervisor image ID, and sandbox runtime image ID. It also requires
the exact reviewed digests for Codex, the native attempt controller, Landlock
launcher, and subscription launcher. New builds require explicit review and
updated pins; a similar version string or caller-supplied hash is insufficient.

Admission requires a live `verifyOwnedNativeHost` capability bound to the exact
CLI executable/private environment, gateway endpoint, workspace and launch
snapshots, checked before and after physical work. The physical adapter copies
every native artifact from a never-started container and hashes the bytes on
the host. Existing canonical public-profile exports, provider-instance and
physical-volume proofs remain required. Missing methods, changed native bytes,
wrong build/image identity or lost custody fail admission.

Only this owned contract can return read-only enforcement capability and allow
explicit reviewer seats or `openai-codex` alongside `openai`. Its allowed roles
are implementer, coder and reviewer; Claude and broader roles remain excluded.
A personal category in this capability is not personal account authorization:
the application must additionally require both fresh asynchronous identity/
seat proof and synchronous admitted-dispatch proof from its subscription host.
No actual owned-native attestation file was generated by this implementation;
production remains closed pending real account evidence, approved live Luna
acceptance and review.

## Personal login from local and remote browsers

The provider callback is fixed at `http://localhost:1455/auth/callback` and
Mitzo listens only on the server's `127.0.0.1:1455`. Here `localhost` means the
computer running the OAuth browser. A working remote Mitzo web UI does not
make that callback reachable. Mitzo does not change the provider redirect or
expose the callback on a public interface.

The operator-authenticated `POST /api/symposium/personal/login` requires a JSON
`callbackTransport` choice before starting OAuth. Missing or unsupported choices
return HTTP 409 with the local/SSH instructions and no authorization URL. The
choice is an explicit operator confirmation of the browser setup, not an
automatic connectivity test; proxy headers and client IPs cannot prove where
the browser will run.

- For a browser running **on the Mitzo server**, send
  `{"callbackTransport":"host-local"}` and open the returned `authorizationUrl`
  in that browser.
- For a browser on **another SSH-capable computer**, first run the following on
  that computer, replacing `USER@MITZO_HOST` with the server's SSH destination:

  ```sh
  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 USER@MITZO_HOST
  ```

  Keep the tunnel running, send `{"callbackTransport":"ssh-forwarded"}` to the
  login endpoint, and open the returned URL on the same computer as the tunnel.
  If the tunnel cannot bind local port 1455, stop and resolve the port conflict
  before starting login. Forwarding the web UI port alone is insufficient.

- For a **phone or browser without a local SSH forward**, complete login in a
  browser on the server or on a computer using the SSH flow above. Do not open
  the OAuth URL on the phone. After login, the phone can use the resulting
  personal account through Mitzo's account catalog.

Both the listener and the tunnel bind IPv4 `127.0.0.1` only. The browser must
resolve `localhost` to or fall back to `127.0.0.1`; IPv6-only `localhost` (`::1`)
will not reach this listener. Fix local name resolution/browser connectivity
before login; keep the registered callback URL unchanged.

Complete login within ten minutes. The callback page reports success or failure;
refresh `/api/symposium/accounts` after success. If the host cannot bind callback
port 1455, the route returns HTTP 503 with a port diagnostic; resolve the conflict
and retry. Do not copy callback URLs, authorization codes, or tokens into logs or
chat. This workflow does not require any gateway patch or alternate provider
redirect URI.
