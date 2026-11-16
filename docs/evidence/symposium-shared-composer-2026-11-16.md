# Shared composer and default repository repair

## Operator refinement after mock revision 1

Dimitri rejected changes to the existing top Agents actions, a permanent duplicate
roster and text-labelled composer actions. Revision 2 keeps activity, sharing
policies, preview, Details, Chat settings and Add agent in the original Agents
dialog. Inline recipients start collapsed behind @, retaining selected-agent color
marks. Existing lightning, Queue and the Send/Stop slot remain icon-only. Queue
uses explicit shared delivery rather than enabling the ordinary local outbox on
this bounded route. Steer/Queue controls retain their position while typing.

A regression reproduced three scroll-to-bottom writes for three draft keystrokes
with unchanged transcript inputs. Shared transcript composition now memoizes its
actual projection, ordinary history and streaming inputs independently of the
composer draft. Typing produces no scroll write; real streamed content still
follows the reader at the bottom and preserves a reader inspecting older replies.
Recipient focus uses preventScroll. Source identity deduplication and historical
packet suppression remain covered by the existing transcript tests.

The refinement's focused regressions cover 379 passing tests across 32 files,
with one existing skip, including the 27-turn production-composer journey. A final
fixture-assertion follow-up retains its exact repository and AbortSignal checks.
The offline browser fixture now includes long history and checks the reader's
position while typing. Revision 2's in-memory interaction checks cover
collapsed selection, existing icon geometry, Send/Stop swapping, no typing-induced
scroll writes, selected-agent control, the preserved Agents options and simulated
fresh-agent joining. Browser geometry remains unverified under the retained host
process-registration denial; no browser retry was attempted.

The original draft PR is #1374 at `86364844`. Its first CI run exposed compiler
errors in the image type boundary, nullable journal input, ES2022 findLast usage and
test fixtures/query options. This follow-up corrects those reported errors without
weakening runtime validation or changing target libraries. Full compiler and
rendered CI evidence remain required for the updated head.

One implementation in the existing task checkout retains the default-repository
joining work and addresses Dimitri's 16 November shared-chat UX report. No further
agents or model calls were started for implementation or testing.

## Behavior and patterns

- Add agent resolves the configured ordinary primary repository through the
  account/runtime-bound preparation owner. Alternate repository selection remains
  available. Review retries and brief edits retain the same concrete preparation.
- Inline shared toolbar controls select one or multiple recipients while agents
  run. @ focuses the existing input and filters names without opening a popup.
- One Stop control routes to the selected original commands. Steer uses the
  existing exact-command correction endpoint, retaining per-agent outcomes.
- Durable send, Stop and correction journals preserve original request identity;
  disjoint recipient work remains available after an uncertain acknowledgement.
  Restoration observes retained activity and never automatically replays controls.
- Ordinary image paste/previews feed canonical shared messages and native image
  input. Text history contains image fingerprints rather than raw base64 text.
- Existing transcript bubbles integrate the agent name, stable seat accent and
  source-recorded time. Historical messages without time retain unknown time.
- Existing status rail owns actionable feedback. Updating a notice preserves its
  order rather than removing and appending it on every render.

Shared patterns: ChatInput and its draft/attachment owners, ComposerResponders,
ComposerStatus, transcript bubbles, ordinary runtime preparation and native control
owners. Colors, typography, spacing and touch targets use shared tokens and seat
accents. The speaker border and selected-recipient underline use 2px geometry;
the recipient strip scrolls horizontally within a bounded toolbar width.

## Verification and remaining limits

The focused regression set covers 525 passing tests across 37 files, with one
existing skip. A final ledger follow-up rechecked the original approval and design
guards after preserving that baseline as a separate active surface. Coverage
includes approved setup checks, real authenticated application
image delivery and canonical Stop routing, default-repository retry/brief editing,
recipient switching, multi-agent controls and receipt recovery. Protocol, harness
and client TypeScript project builds passed. Changed TypeScript lint passed. The
27-turn production-composer journey passes through remount and history paging.
Stop recovery also covers an unrelated membership addition, while refusing future
revisions, removed targets and forged command identity. Unexpected router and
delivery errors retain their original cause internally and log only sanitized
diagnostics with a correlation identifier.

The offline mobile Chromium fixture was updated for inline recipients. The first
startup found no browser in the executor's temporary home. Selecting the existing
cache for the same installed Chromium revision then reached a macOS process
registration denial (`bootstrap_check_in`, permission denied). No subsequent launch
or alternate binary was attempted. Phone/desktop, theme/accent/font rendering,
scrolling and keyboard geometry remain unverified and require the authorized CI
browser environment. There are no new visual captures.

The full frontend typecheck exceeded the required 1 GiB Node heap; broad build and
type validation remain for CI. No staging, deployment, production runtime changes,
live model tests, publication or merge occurred.

The earlier context inspector remains active in Telos (`05f51bcee39031b1`, UI slice
`5e5b6f6cbc37df2e`). This work keeps the current wheel mounted and labelled with its
actual usage owner; it does not establish that the prior redesign landed.
Local Mac Codex and Claude retain their existing configured account/runtime
qualification. OpenShell shared delivery remains unqualified; this repair does not
establish universal account or engine support.
