# Scoped S7 LifeOps test consumption

18 October 2026. B commit `68f5bec12f8bfe5edc81f3e11e0eedbce21c32f0`
consumes only `server/__tests__/telos-document-editing.test.ts` from S7 commit
`92eb883b59806d9178e1e7da04d1d2dca6e05a95`. Original author and author date
are retained, and the source commit/scope are recorded in the commit body.
The resulting file exactly matches S7 bytes, SHA256
`ac3a3641afca22ab60fcd0e82a7eacae2f70fc36e31aa8ec9505ea2a97c9e9e0`.
No unrelated S7 work was copied. No producer route, shared integration or UI changed.
Core receives the original scoped pin independently; B sends no duplicate patch there.

The existing test now proves public GET200/editable:true before profile change;
both default and revision1 private GET403/error-only afterward; PUT403 with the
private-storage policy error; direct store editable:false; and original revision1,
hash and exact bytes unchanged. Denial is preserved rather than relaxed.

Focused synthetic checks pass42/4files, zero skips, one worker/1GiB. Command:

```sh
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/vitest run server/__tests__/telos-document-editing.test.ts server/__tests__/collaboration-artifact-versions.test.ts server/__tests__/telos-artifact-store.test.ts server/__tests__/telos-artifact-routes.test.ts --maxWorkers=1
```

[Exact output](lifeops-scoped-consumer-green.log). Normal hooks pass.

## Current completed CI checkpoint

Ordinary CI [39082602932](https://github.com/dimakis/mitzo/actions/runs/39082602932),
head `107c230a87a5adb374d4cc2a2fc37ec3d331e9e4`, precedes this LifeOps correction:

- ci117542498416 fails only the earlier LifeOps assertion in its full suite.
- Native Swift builds117542536688, browser interaction117542536658, desktop
  Chromium layouts117542536679 and mobile Chromium layouts117542536830 succeed.
  These jobs demonstrate the earlier producer type fix compiles in CI; local
  full frontend typing remains constrained by its recorded1GiB heap exhaustion.
- Mobile WebKit117542536674 fails `telos-role-setup.spec.ts:37` light ordinary
  lead setup at line562. Its expected empty errors list instead contains
  `/mitzo-ui.test/api/service-health due to access control checks.` Result:
  241 passed /1failed /12skipped. This is separate from B artifact journeys and
  is reported through the reviewer for the appropriate Telos fixture owner.
- Connections aggregate117545083800 reflects that WebKit failure. No full green
  current-head CI or final review is claimed.

Raw failed log is retained at
`/private/tmp/symposium-B-pr1020-39082602932-failed.log`.
No model, live account, staging, production, merge or deployment was used.
