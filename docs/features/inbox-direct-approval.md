# Shared tool and approval headers

Dimitri requested direct Inbox approval on 10 November 2026: “It should be one
click, no scroll.” After reviewing the interactive shared-header mock, he
approved the broader change: “Yep. For every tool. Build it”. The originating
conversation, exact reference and scope are retained in
[the approval record](../design/approved/tool-operations/VALIDATION.md).

Every web tool family now uses `OperationCard`: type/icon, operation and scope on
the left, primary action or status at the top right, and optional full evidence
below. This includes commands, files, integrations, unfamiliar tools, grouped
calls, delegated agents, connection/repository setup, task review and worker
receipts. Completed activity uses quiet rows; actions remain above collapsed
activity. Original tool output, failures and interruption states remain available.

`ApprovalCard` supplies the same decision layout in Chat, Inbox entries and the
notification inspector. Approve, Grant, Send answer and source-save actions sit
beside the operation. More holds eligible session retention and secondary
decisions. Known command/access facts stay visible; Details exposes original
evidence without moving the action below it. Long evidence and question forms
scroll independently of the Chat overlay header.

The old notification renderer tied conversation Grant to session eligibility;
when session grants were disabled, it could show only Deny. Conversation Grant
now has its own primary action and retains each transport's original decision
encoding. Incomplete live payloads expose Review to the original session and a
visible explanation. No generic approval is fabricated from an incomplete record.

The server still owns request identity, scope, expiry and settlement. Questions
require their original answer; sending locks choices and duplicate actions.
Errors retain draft state for retry. Expiry fabricates no denial. Source review
uses its original preview/save/change/recovery controller, source selection,
immutable retry identities and authenticated reads. Recovery keeps Dismiss even
when the original creation tool normally uses Cancel. Resolved, archived and
expired records expose no approval actions. Historical question prompts remain
readable. Existing nested native-child inspection and native Watch review keep
their separate approved contracts.

## Validation as of 11 November 2026

Focused checks cover top actions, all generic tool families, exact response
payloads, session eligibility, source review/change/recovery failure paths,
question drafts, expiry, duplicate prevention, retained activity and validated
setup/worker/task navigation. The approved-design ledger retains earlier
revisions and pins the newly approved reference and updated contracts.

After integrating main's UI sizing/motion update `8605952b`, 469 focused
unit/design checks passed with one existing skip. Submission failures remain
visible after a successful feed refresh, and the same card can retry. Six real
component browser fixtures bundled successfully; changed TypeScript passed
ESLint and reviewed source fingerprints verified.

Offline fixtures cover phone WebKit/Chromium and desktop Chromium, light/dark
themes, alternate fonts/accents, larger text, long evidence, focus and 44px
controls without backend or model calls. Local execution remains limited:
macOS denies browser process registration, and the full UI build/typecheck
exceeds the mandated 1 GiB local heap. No new rendered screenshot is claimed;
full build/typecheck and rendered browser execution remain required in CI.

Prepared from Mitzo source `9f165ea599d8`, integrating `8605952b`, in an isolated task clone. This record
proves saved implementation and its reported verification, not merge, deployment
or production acceptance.
