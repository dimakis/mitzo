# Context snapshot inspector candidate

Ordinary contribution to existing slice `5e5b6f6cbc37df2e`, coordinated by
`d933a61d-7363-85ab-a329-93e6dc5a2050`. No canonical assignment, ownership or
completion changes. This independent checkout starts at PR #1431 exact head
`18afc8a0a0d196687df50fd3301a454bb1e9e28d`, which depends on PR #1424
`d88b662f20bd77cf9f06e6f2b04c6ee72886bf63`. The held `413c30fc` integration is
excluded. The source checkout and sibling branches were not edited.

## Delivered boundary

The existing single-agent TokenBar popover and per-agent recorded-usage dialog
gain an Inspect context action. ChatInput supplies its existing session ID.
The ring, composer placement, token-update propagation, microphone and retained
ChatInputHost remain under their existing owners. No backend, protocol,
fingerprint or client-store changes are required.

The hook validates `ContextSnapshotResponseSchema` from the authenticated
`GET /api/sessions/:id/context-snapshot`. The response establishes the initial
native scope; the browser does not manufacture a scope from legacy usage or
model-picker intent. Only parent observations for the requested session enter
this view. The first scope pins the open inspection. Later scope changes,
decreasing revisions and older observation times discard the reply and ask the
reader to close/reopen. Server-side native ownership and authority checks remain
essential; this local fence is not a separate authority source.

Opening and Read saved snapshot are passive GETs. Refresh summary sends an
explicit summary POST. Full detail is offered for an observed Local Claude
binding and requires separate, unchecked consent for token-count calls, network
overhead and possible charges. Each action gets a new UUID and the required
`X-Mitzo-Context-Intent`; full alone includes `allowTokenCount: true`.
No effect, timer, retry or recovery path issues a full request automatically.
A failed/expired full reply preserves uncertainty about token-count work.

Close, unmount, conversation switch, participant unavailability, logout and new
authentication abort the current read and fence late headers/bodies. HTTP 403
and `authority_expired` remove observations and disable actions until reopening.
Every request has a ten-second browser deadline, including body parsing; this
does not claim to undo native work. Observation expiry updates the freshness
label locally with no network request. Server loading is a visible state, not a
polling instruction.

Exact numeric rows show occupancy estimates separately from latest-request
input/output and included cache/reasoning subsets. Missing values stay unknown;
real reported zero remains zero. Resolved/usable windows, model limits, reserve
and free observations stay distinct. Stale capacity is labelled and is never
used to derive free space or a percentage. Deferred/unknown categories,
assurance, signed residuals and overlap/inventory/unknown contribution relations
remain explicit. Contribution lists initially render twenty rows. No opaque
`sourceRef` is converted to a path, link or resolver call.

`adapter_not_attached`, `refresh_unsupported` and unsupported ordinary
Claude/OpenShell remain honest unavailable states. This UI installs no native
port and does not qualify any of the four engine/placement routes.

## Verification — 21 November 2026

- Test-first red: the new consumer suite failed on the missing inspector module.
- 83 focused rendered tests pass: 36 new inspector cases, plus TokenBar (25),
  ChatInputHost (8), MicButton (11), ConversationContextUsage (1) and
  SessionContextUsage (2). Real schema and api-fetch are used, with intercepted
  fetch and the repository's native-dialog jsdom stub. Coverage includes every
  transport status, malformed/additive/versioned responses, wrong session and
  parent scope, binding changes, revocation, late A→B and body replies, expiry,
  deadlines, exact refresh intent/consent, unknowns, signed accounting and
  per-agent/legacy separation.
- `npm run test:design -- --maxWorkers=1`: 109 pass, one existing skip. Approved
  ledger references/checks and shared token/motion guards remain unchanged.
- Focused ESLint and TypeScript checks pass for the inspector, hook, TokenBar,
  ConversationContextUsage and rendered consumer tests. The focused TypeScript
  configuration extends `frontend/tsconfig.json`, includes `src/vite-env.d.ts`,
  selects those entry points and clears project references. Packages built during
  the UI-check prerequisite. All checks use one worker and a 1 GiB Node heap.
- The full UI build prerequisite (`npm run test:ui -- --help`) stopped in
  frontend `tsc -b` with heap exhaustion at the required 1 GiB limit. It did not
  reach Vite or browser execution. No larger-heap retry was made.
- The isolated all-intercept browser fixture bundles the real ChatInput,
  ChatInputHost, TokenBar and inspector. Six scenarios cover 320px/desktop,
  light/dark, Mint/System and Teal/Georgia, larger text, reduced motion,
  passive opening, keyboard consent, 44px controls, Escape/focus restoration,
  retained drafts, recording/transcription and conversation switching.
  `playwright --list` enumerates all six plus two startup checks.
- Actual browser execution is **blocked**: desktop Chromium startup reports the
  required headless-shell executable missing in TaskExecution's isolated home.
  An own-workspace `playwright install chromium --only-shell` attempt failed
  after the CDN closed the download connection. No dependent browser scenario
  ran, no screenshot was captured, and layout/focus/visual acceptance is
  unverified. There was no macOS process-registration attempt or denial in this
  checkout. Re-run the retained fixture on an admitted host with the matching
  browser installed; do not treat test listing as execution evidence.

The published transport baseline of 95 focused tests belongs to #1431; this
candidate does not relabel that prior evidence as a new run. No release
node_modules, provider configuration, model calls or paid token counts were used.

## Review and landing

Review the incremental diff from `18afc8a0`, together with the declared dependent
PRs. Full build/browser acceptance remains outstanding. No CI monitoring, merge,
deployment, activation or main-only refresh was performed. Later landing still
requires exact-head CI, trusted Centaur final LGTM and merge recommendation with
the valid App gate. This candidate is not broad canonical feature completion.
