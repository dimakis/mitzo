# Disposable Symposium gateway TLS

The owned Podman gateway advertises `https://host.containers.internal:<port>` to
sandbox supervisors. Its management client and private issuer use `127.0.0.1`.
A localhost-only certificate can pass host startup yet prevent every sandbox
supervisor from fetching configuration. Startup now rejects a server certificate
unless it has both the exact `host.containers.internal` DNS SAN and the
`127.0.0.1` IP SAN. CN fallback and wildcard matches do not satisfy this check.
This is a hostname preflight, not evidence that a sandbox or model is available.

For a **new disposable instance**, run:

```sh
OPENSSL_BIN=/opt/homebrew/opt/openssl@3/bin/openssl \
  sh scripts/symposium/create-disposable-tls.sh /absolute/new-private-tls-directory
```

The offline helper refuses an existing directory, creates private seven-day test
CA/server/management material, and verifies both server endpoints and client
usage. It performs no OAuth, model call, gateway launch, or modification of a
running instance. Never pass a live instance's TLS directory. Keep the CA and
private keys host-only; do not commit or print them.

Point a new private owned-host configuration's `tls.serverCert`, `serverKey`,
`clientCa`, `managementCert`, and `managementKey` at `server.crt`, `server.key`,
`ca.crt`, `management.crt`, and `management.key` respectively. Use a fresh private
state parent, separate free loopback ports, reviewed binaries/images, and fresh
JWT signing material. Existing authenticated gateways remain unchanged. Fresh
OAuth must be attended separately after the new instance is reachable; copied
credentials or a saved receipt cannot authorize a replacement gateway.

The regression tests use locally generated disposable certificates and mocked
gateway processes. They prove rejection before issuer/process startup and
acceptance of the required SANs; they do not claim live sandbox or inference
success.

The helper requires OpenSSL with `req -addext`, `verify -verify_hostname` and
`verify -verify_ip`. It checks these capabilities before creating the destination.
macOS `/usr/bin/openssl` may be LibreSSL without those flags; select a supported
executable with `OPENSSL_BIN` (the Homebrew example above), or omit that variable
when `openssl` on PATH supports them. Unsupported binaries fail without leaving
a partial destination. This helper does not install software or change live TLS.
