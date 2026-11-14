# Integrated ordinary conversation surface — slice 1

Implementation base: accepted `main` at `9af764899`. Isolated branch:
`fix/symposium-integrated-conversation`. This slice changes transcript/composer
integration and the existing ordinary owner needed to address the original agent.
Chats grouping remains slice 2's work; combined application acceptance is slice 3's.
No Telos assignment, merge, deployment or real-provider qualification is claimed.

## Result

- Ordinary history and authorized shared messages render through one `ChatArea`.
  Existing rich blocks, live output, permissions and message controls retain their
  owners. Source conversation/message/command identity reconciles echoes; equal
  text from independent sources or commands remains. Independent sequence cursors
  are never sorted together by wall-clock time.
- The ordinary `ChatInput` stays mounted through joining, source activity and
  responsive page changes. The existing status rail, draft, context, attachments,
  Terminal and selection survive. Shared text-only limitations explain what must
  be removed; retained content is not discarded. A retained input follows current
  recipient routing even while a resized page awaits status qualification.
- A newly shared chat explicitly addresses the original named agent. Saved empty
  and default-empty choices stay empty. Choose who replies opens the existing
  picker. Reader and default-reply policies are unchanged by joining or reading.
- Existing shared send/Stop journals own uncertainty, partial successes and
  recovery. Participant removal cannot return pending work to ordinary dispatch.
  Refresh checks stale state; Check original request reconciles uncertain work.
  Source activity cannot replace routing or redirect Stop to a different command.
- Original local Codex and SDK owners can receive observed shared commands through
  their existing authenticated admission. Codex retains an observer per command,
  forwards native acceptance/terminal receipts, and suppresses automatic failed-tool
  continuation for that observed command. No new session or client-only authority
  substitutes for the source's owner. Foreign or unsupported owners remain refused.

## Red/green evidence

Focused production-component regressions first reproduced two transcript containers,
composer replacement, inaccessible empty-recipient recovery, source-running control
replacement, lost rich drafts, echo conflicts and stale routing after viewport
qualification. Assertions exercise `SymposiumConversation`, `SharedConversationHost`,
`ChatArea`, the real `ChatInput` and their hooks. Only HTTP/authentication/external
membership boundaries are deterministic fixtures.

The delayed-status regression retains the exact textarea, draft, focus and selection
immediately after a responsive owner remount. It changes recipients and sends before
the status response returns, checking the exact selected recipient and request count.
Existing unbound-input and backend-refusal tests caught two further integration
regressions; both pass after correction. A final omission regression also proved
that retained recovery notices could reach a retired page's status sink during
qualification. The portal now binds the current status owner, keeping Check original
request visible and functional without replacing the input. CI-reported timer and
session-prompt fixture typing errors were corrected with explicit timer handles and
schema-validated collaboration settings.

The original-owner dispatch test first failed with “Choose a fresh configured group
participant.” It now checks original authenticated Codex/SDK owner reuse, unchanged
transport/client identity, lifecycle forwarding and rejection of another login.
Native adapter tests verify lookup of a later command's observer on the existing
owner; observer tests cover exact-command isolation and terminal/teardown cleanup.

Verified locally, one worker and a 1 GiB Node heap:

- 292 composer, integrated conversation, transcript and sending regressions across
  25 suites; 76 existing `SymposiumConversation` tests also passed.
- 244 native lifecycle, session-prompt, scoped-dispatch and observer tests.
- 176 ordinary Codex/SDK owner, delivery/recovery, contributor Stop/viewer and
  native dispatch regressions across seven suites.
- Design guard: 109 passed, one existing skip. Approved HTML remains SHA256
  `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
- Protocol/harness/client TypeScript builds, focused ESLint, formatting and reviewed
  source registration checks passed.

Representative commands:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run frontend/src/components/__tests__/ChatInput* frontend/src/components/__tests__/OrdinarySharedConversation.test.tsx frontend/src/components/__tests__/SharedConversation.test.tsx frontend/src/components/__tests__/SharedConversationStatus.test.tsx frontend/src/components/__tests__/CollaborationTranscript.test.tsx frontend/src/hooks/__tests__/useConversationSending.test.tsx --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run server/__tests__/ordinary-turn-observers.test.ts server/__tests__/codex-chat-session.test.ts server/__tests__/session-prompt-dispatch.test.ts server/__tests__/ordinary-scoped-command.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 npm run test:design -- --maxWorkers=1
node scripts/check-reviewed-handler-artifacts.mjs --source
npx tsc -b packages/protocol packages/harness packages/client
```

## Independent application and visual states

Slice 3's combined candidate `7f4055305` includes this slice through `5908c4dc6`
and slice 2. Its reported green journey, retained in `d80bd1d89`, uses actual
`ResponsiveChatView`, authenticated application, admission, stores and SSE with
deterministic external native RPC. It covers source/reviewer concurrency, partial
failure, failed-recipient-only retry, long history, lost send/Stop responses, one
interrupt, exact retry without replay, reconnect/remount and application teardown/
reimport of the same database. The later narrow fixes and final combined head still
require slice 3's fresh acceptance/CI results. Source order is identified by exact
thread/command identity; global turn ordinals are not source identity.

`tests/offline/symposium-ordinary-surface.spec.ts` adds the actual ordinary production
composition to the offline browser matrix: remote joining, one transcript, exact
input preservation at 320/390/1280 px, source activity and empty selection in dark/
mint/system and light/teal/Georgia settings. It bundles and lists six scenarios.
Local browser execution is **unverified**: the default executable was absent;
dependency installation downloaded Chromium but failed downloading FFmpeg. The
supported executor's attempt to launch that installed Chromium failed macOS Mach
bootstrap/socket registration permissions. No denied launch was repeated or sandbox
guard bypassed. Hosted browser execution and capture inspection remain required.

The full frontend typecheck exceeded the local 1 GiB heap. Full frontend/server
compilation and production build remain hosted CI checks. Physical-device behavior,
the user's exact failing phone build/request and production acceptance remain
unverified. No real model calls, credentials or private reasoning were used.

PR #1347 was inspected: open/draft at `4f5dd94981c9c4bd4b9b31e639a3fae7f560772f`,
conflicting, and scoped to joining readiness/permissions/dialog bounds. This slice
does not duplicate that implementation. Merge priority remains the complete Claude
parity stack first, then integrated Symposium validation and exact-head Centaur/CI
gates under separate merge authorization.
