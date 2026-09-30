# Fresh Symposium Git artifacts

Fresh draft preparation now creates a UID/GID-owned volume and initializes an empty Git repository on branch `main`, without a seed upload, commit, author, remote, template, ambient Git config, or credentials. The initializer uses the reviewed immutable workload image, no network, a read-only root filesystem, dropped capabilities, and a 20-second container lifetime limit.

The existing session-artifacts ledger retains helper name intent before creation, immutable helper ID before start, and terminal removal before readiness. The initialization contract binds the image, UID/GID and script hash. An older ownership-only receipt is insufficient. Nonempty volumes cannot be initialized or adopted. Once ready, repeated preparation performs inspection without rerunning initialization.

Unknown helper creation, failed start, failed receipt persistence, or uncertain cleanup retain the volume reservation and any known helper identity. There is no automatic initialization retry, name-based deletion, volume deletion, or recovery/adoption added by this change. Successful terminal initializer creation is recorded before the next custody check. A helper whose ID receipt could not be persisted remains identified only by its durable name intent and must not be deleted based on inventory alone. A failed/ambiguous start retains the bounded helper for reconciliation. Restart reconciliation remains a separate required capability.

## Credential-free physical contract

Run on a host with Podman on PATH (or set `MITZO_CONTRACT_PODMAN` to its executable) and the pinned workload image already installed:

```sh
MITZO_ARTIFACT_PHYSICAL_CONTRACT=1 npx vitest run server/__tests__/symposium-artifact-physical.contract.test.ts
```

The opt-in test uses the production volume-create/initializer callback and SQLite preparation ledger, verifies the exact pinned native binary hashes, then invokes the actual native attempt controller. It checks writer Git commit, independent read-only reviewer reading the same commit, physical read-only mount denial, native read-only grant denial, rejection of nonempty initialization, unchanged commit afterward, and exact resource cleanup. It writes a private evidence record under the OS temporary directory as `mitzo-git-contract-*` with helper IDs, volume generation, commit and native terminal receipts. Failures retain the fixture ledger for investigation instead of deleting unknown resources.

This lane has no provider credentials, login, gateway, or model calls. It is physical artifact/controller evidence, not full application seat admission, TLS/gateway behavior, restart recovery, trusted review, account isolation, seal/export, publication, or production acceptance. Normal CI skips it unless explicitly enabled on a provisioned runner.

## Owned runtime contract and compatibility

`server/symposium-owned-runtime-contract.ts` is the shared source for the reviewed owned build, workload UID/GID, and canonical working directory. Admission pins, artifact ownership, mounts, native transport, owned-host setup, and the physical test derive from it. The initialization receipt additionally binds the canonical target and initializer script hash. This consolidation changes no runtime versions, native binaries, image identities, or legacy production lock.

Opening a retained ledger with an ownership-only receipt, a target-less Git receipt, or a different target/image/owner/script contract fails closed without recreating its volume. The retained volume identity remains available for explicit reconciliation. The SQLite schema is still additive; this change does not establish a supported downgrade protocol or prove that every older application binary will honor newer receipt fields. Rollback to older code, credential custody migration, and automatic reauthorization of existing volumes remain unsupported and require a separate reviewed migration decision. Keep operation-specific verifier/export receipts separate; this contract is not an aggregate application/runtime/database rollback manifest.
