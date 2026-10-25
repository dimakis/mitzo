# node-forge RSA verification backport

`node-forge@1.4.0` has no published fix for [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). The upstream [PR #1152](https://github.com/digitalbazaar/forge/pull/1152), commit `ceba344`, proposes checking the exact nested DigestAlgorithm element count as well as the outer DigestInfo count.

Mitzo applies that narrow check to the unchanged npm archive, retaining the upstream BSD/GPL license files and attribution. The output is explicitly named `@mitzo/node-forge-security@1.4.0-mitzo.3`; it is a Mitzo backport, not an upstream release. All `node-forge` consumers resolve to this archive through the root dependency/override. No audit finding is suppressed.

Run `node scripts/build-forge-security-backport.mjs` to rebuild it, or add `--verify` for a byte-for-byte offline reproduction check. The input archive is checked against the upstream npm SHA-512 already recorded in the previous package lock. Only `lib/rsa.js` and package metadata change; unpatched prebuilt browser bundles and Flash assets are excluded from this Node-only fork. Package lifecycle scripts and development dependencies are removed from the runtime backport; license and runtime source files remain.

Cryptographic regression tests reject malformed nested sequences both with and without NULL parameters, preserve valid signatures in both forms, and check Node-generated signatures and tampered messages. They also verify that the installed package is the backport and its archive is reproducible. The normal build verifies the backport before deployment.

Replace this backport with an official patched release when one is available, retaining the regression tests. Do not increase the upstream version or change the archive without reviewing and regenerating its provenance and lock integrity.

Archive generation fixes entry order, file mode, uid/gid, timestamps and gzip headers. RFC 1951 stored blocks avoid differences between zlib compressor releases. Only JavaScript runtime files and package/license/readme metadata are included; patch-tool backup files cannot enter the archive. This builds offline without npm pack or lifecycle scripts. Node 24 is required for the built-in CRC-32 implementation.

# Zod 3 bounded-collection backport for sandbox-runtime

The pinned `@anthropic-ai/sandbox-runtime@0.0.75` requires the Zod 3 API. The Zod [advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) lists `<4.6.6` as affected, but the published fix is for Zod 4. Forcing that major into sandbox-runtime would change its API and declarations; Zod 4's `/v3` entry still has the old implementation.

`@mitzo/zod3-sandbox-security@3.25.76-mitzo.1` is an explicit Mitzo backport from the retained, SHA-512-verified `zod@3.25.76` npm archive. Its small patch follows [upstream commit a0ebf970](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd): oversized array `.max()`/`.length()` and set `.max()` inputs abort before element parsing. ESM, CommonJS and TypeScript source carry the same change. Zod 3 maps have no corresponding size-bound API. Valid bounded inputs and too-small checks retain their behavior.

**This protects constrained collections only. Unbounded schemas, including sandbox policy arrays without a length bound, retain their existing behavior. This is not a claim of general resource-exhaustion protection for arbitrary sandbox policies.** No new runtime limits or policy prewalk are added. The scoped override changes only sandbox-runtime's Zod dependency; Mitzo's existing Zod 4 consumers use official `4.6.6`.

The override's relative archive path is resolved by npm from the pinned consumer at `node_modules/@anthropic-ai/sandbox-runtime`; the lock records the repository-relative archive and its integrity. Required v3 entry points, declarations, TypeScript source, attribution and MIT license remain. Unused, unpatched embedded v4 code and exports are excluded. The package does not impersonate an upstream fixed version or suppress an audit advisory.

Run `node scripts/build-zod3-security-backport.mjs` to rebuild, or add `--verify` for offline byte-for-byte reproduction using the same canonical archive writer as the forge backport. Normal server builds verify both backports. Regressions demonstrate parser work before and after the fix in both consumed module formats, synchronous and asynchronous behavior, unchanged unbounded behavior, and actual sandbox-runtime configuration parsing. Replace the backport with a compatible official fixed release when one exists, retaining the regressions.
