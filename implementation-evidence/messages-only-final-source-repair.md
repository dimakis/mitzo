# Messages-only original-source renewal

18 October 2026. CEN-FA9846A6BB29 source repair:
`eacc2396184cf8e0a89ee0e43cfa69e5e1e2bd15`, tree
`8caeefadc5f504f053ab70a062182993208e7a60`, draft PR1020.
The Symposium reviewer assigned B sole producer/test repair; core retains its
private save/page integration and a separate actual private-save regression.

The producer's artifact maps were empty for messages-only selections. An edit or
access change after the last source await, or between the outer continuation and
serialization, could therefore escape the local check. Extra async checks do not
close that boundary.

For every non-null transcript-backed selection, the existing local check now
requires and invokes the original source capability's `assertCurrentAtSave():void`.
It retains the source's original opened witness and genuine synchronous operator/
privacy owner; it does not open a new witness or accept a caller allow flag.
Missing method/operator owner and Promise/value returns refuse. The check runs
after the final awaits, immediately before serialization and through the unchanged
private `prepared.assertLocalMaterialCurrent():void` handoff. Artifact checks remain
in place. Asynchronous authorization is retained.

The private deps type adds optional `assertCurrentAtSave?():void` to the source
capability, with mandatory runtime validation for source-backed packets. Retained-only
packets with null source/boundary remain independent: an unavailable source supplied
in deps is neither opened nor renewed. Core still composes genuine target/membership
and retained-access authority in its existing transaction. No public rights, request
schema, selector/fingerprint owner, storage, queue, dispatch or route is added.

## Test-first evidence

[Red](messages-only-final-source-red.log): the first12 new actual-owner cases yielded
10 failures and2 existing last-target guards green, with all37 prior producer tests
still green. The failures cover messages-only content/access changes after the last
source await and the outer continuation; missing, Promise/value or missing-operator
source renewal; and returned local checks after post-prepare changes. The outer case
uses two microtask boundaries to prove the final serialization fence separately.

Three further guards cover independent retained-only lifetime with an unavailable
supplied source and later Promise/value returns on the returned local/save check.
[Green](messages-only-final-source-green.log):169 passed/4files, zero skips, including
all52 producer cases and original retained-source/source/compiler checks. Existing
mixed-packet and artifact final-await assertions are preserved. Original witness
opening count and absence of new async authorization are asserted.

```sh
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/vitest run server/__tests__/collaboration-forwarding.test.ts server/__tests__/collaboration-retained-artifact-source.test.ts server/__tests__/collaboration-context-source.test.ts server/__tests__/collaboration-context-compiler.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --esModuleInterop --strict --skipLibCheck server/collaboration-forwarding.ts server/__tests__/collaboration-forwarding.test.ts
```

Strict targeted TypeScript, [source fingerprints](messages-only-final-source-closure.log)
and normal hooks pass. One worker and1GiB; no model, staging, production or runtime
configuration used.

## Core consumption

[Patch check](messages-only-core-patch-check.json) applies only the producer delta to
a temporary copy of committed core61b5c852. The actual core checkout is untouched;
canonical protocol imports/exports and fingerprint function remain unchanged.
The patched core producer hash is
`8eb6d7b32dab93b30b92241c9e83b9bd24ef644c38b0648c363847679e2ccdcb`.
This proves patch compatibility, not successful core integration or transaction
qualification. Core preserves its canonical selector and combined source manifest;
B's source hash differs because its pre-integration selector declarations differ.
Core was given the exact interface and committed pin before its separate private
save regression. Final combined CI and exact-head trusted review remain open.

Branch refresh: accepted main15090f2f (#1007/#1017/#1018) is incorporated in merge
dd9550b4. Only the source-manifest conflict needed resolution; both accepted and B
fingerprint sets are preserved. The producer and its test file remain byte-identical
to eacc2396. All169 focused checks pass again on the combined branch, and the
complete source-fingerprint verification passes at
v1.0.303-tool-builder-symposium-forwarding.5. The separate original code commit
remains the consumable core delta; core need not consume this refresh.
