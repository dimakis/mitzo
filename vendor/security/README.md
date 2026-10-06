# node-forge RSA verification backport

`node-forge@1.4.0` has no published fix for [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). The upstream [PR #1152](https://github.com/digitalbazaar/forge/pull/1152), commit `ceba344`, proposes checking the exact nested DigestAlgorithm element count as well as the outer DigestInfo count.

Mitzo applies that narrow check to the unchanged npm archive, retaining the upstream BSD/GPL license files and attribution. The output is explicitly named `@mitzo/node-forge-security@1.4.0-mitzo.2`; it is a Mitzo backport, not an upstream release. All `node-forge` consumers resolve to this archive through the root dependency/override. No audit finding is suppressed.

Run `node scripts/build-forge-security-backport.mjs` to rebuild it, or add `--verify` for a byte-for-byte offline reproduction check. The input archive is checked against the upstream npm SHA-512 already recorded in the previous package lock. Only `lib/rsa.js` and package metadata change; unpatched prebuilt browser bundles and Flash assets are excluded from this Node-only fork. Package lifecycle scripts and development dependencies are removed from the runtime backport; license and runtime source files remain.

Cryptographic regression tests reject malformed nested sequences both with and without NULL parameters, preserve valid signatures in both forms, and check Node-generated signatures and tampered messages. They also verify that the installed package is the backport and its archive is reproducible. The normal build verifies the backport before deployment.

Replace this backport with an official patched release when one is available, retaining the regression tests. Do not increase the upstream version or change the archive without reviewing and regenerating its provenance and lock integrity.
