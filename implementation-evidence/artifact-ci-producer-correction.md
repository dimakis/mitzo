# Artifact producer CI correction

18 October 2026. Consumable source commit
`e8c0c750dbb485fa9c818f14f7db3d3536156315`, tree
`78e4ecb0a261ce6246df2b967c8f2893694cbb53` changes only two B-owned test files.
Core owns the integrated producer; no shared producer/protocol, route, approval
reference or UI behavior was changed here.

`SavedArtifactDialog.test.tsx` now declares its fixture result and controlled state
as the real `TodoOutput` contract, which permits absent session metadata. The state
setter therefore accepts exactly the component callback type; no cast suppresses
an incompatibility. `WorkOutputs.navigation.test.tsx` uses anchored accessible-name
regexes `/^Open$/` and `/^Done$/`, retaining exact matching with valid ByRoleOptions.

The exact three TypeScript failures were reproduced before the correction.
[Red](artifact-ci-types-red.log) → [green](artifact-ci-types-green.log) used:

```sh
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --jsx react-jsx --types vite/client --esModuleInterop --strict --skipLibCheck frontend/src/components/__tests__/SavedArtifactDialog.test.tsx frontend/src/components/__tests__/WorkOutputs.navigation.test.tsx
```

All 25 component checks across SavedArtifactDialog, WorkOutputs and its navigation
suite pass, one worker and 1 GiB heap; [output](artifact-ci-component-green.log).
The actual full `NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/tsc -b frontend`
attempt exhausted the heap ([diagnostic](artifact-frontend-project-types.log)). It was
not retried with more memory. Full frontend/build/browser/iOS gates remain CI work;
passing targeted tsc is not reported as a full project build. Normal hooks passed.

## LifeOps contract, shared-test owner S7

B did not edit `server/__tests__/telos-document-editing.test.ts`; the reviewer assigned
that shared test to S7. The existing read hardening already denies the whole shared
route after the item profile changes to `lifeops`, so a 403 error response has no
`editable` document field. Returning private content with `editable:false` would
weaken the intended read policy.

[Actual diagnostic](lifeops-read-policy-diagnostic.json) uses a canonical
TodoStore-created synthetic database, supported artifact initialization and the real
artifact router on an owned loopback listener. Before the profile change, GET is
200/editable:true. Afterward: document GET403 `Telos document unavailable`, pinned
export GET403 `Telos artifact unavailable`, edit PUT403 `LifeOps documents require
private case storage.` Direct store.document remains editable:false; revision1,
its hash and exact original bytes are unchanged. The diagnostic asserts that no
content or path is exposed. No route repair is needed for this observed failure.
The full denial/store-false/unchanged-byte evidence was sent through the reviewer
for S7, preserving single ownership and the original private-storage requirement.

## Raw CI audit

Read PR1020's ordinary CI run
[39077656313](https://github.com/dimakis/mitzo/actions/runs/39077656313), exact
head `f61c59938ecc0c8eae56728da2ac72de2bf774b0`. Failed raw jobs were retained at
`/private/tmp/symposium-B-pr1020-39077656313-failed.log`:

- ci117528241777: the same three frontend type errors; the sole backend assertion
  failure is LifeOps `editable` on the now-denied read. No additional B backend
  failures were found in this run.
- mobile-WebKit117528667283, desktop-Chromium117528667331 and
  mobile-Chromium117528667332: same compile failures before layout execution.
- native117528667243: same web-assets TypeScript failure; later iOS copy reports
  missing `App/public` and its build/link step fails. Native qualification is not
  inferred from this correction; CI must rebuild web assets and rerun it.
- browser interaction job passed; aggregate Connections failure is downstream of
  the failed layout jobs.

Reviewer-supplied PR1023 raw jobs117533730281/117533759360/117533759280 repeat
these producer type errors. Core's own raw ci log also contains separate reconcile
contract rootDir/signature type failures and SymposiumConversation mock failures
for missing AUTH_LOST_EVENT; these remain with the respective integration owners.

This is synthetic offline validation and raw CI inspection. No model, external
account, staging, production, runtime activation, merge or deployment was used.
