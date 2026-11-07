# Apple Watch approval coverage

Implementation record, 7 November 2026. This change is source work; it does not
establish an installed native version or physical push acceptance.

Previously, notification buttons were restricted to Bash and a few web operations.
Most native Codex and integration approvals offered only Review request. Questions
and conversation access could send the Watch user back to the iPhone.

The server now selects banner actions by the complete pending request rather than
the tool name. This includes native command/file/permission requests, task
authorization and integration tools. Once-only requests have no session button;
conversation grants use a separate Grant to conversation action. The pending
owner verifies the displayed parameters against the real operation. Summarized,
oversized and specialized requests keep their full authenticated review path.

With sensitive previews disabled, the banner continues to hide request details.
Approve or deny opens the exact request on the Watch, where its full details and
applicable decisions are available. With previews enabled, complete inputs up to
768 UTF-8 bytes can expose direct buttons, subject to the existing 3 KB envelope
budget. Large details are never silently truncated to retain approval buttons.

Watch questions support single/multiple selections, dictation/freeform answers
and secure entry. Responses retain the original question IDs and validate choices
before forwarding through the iPhone. The server remains the final decision owner.

Telos source permissions use the existing source-review, preview and save APIs.
The Watch displays the complete proposal and available original exchange/material
choices, then the host-compiled preview before Save. An uncertain save retains the
same request ID and preview digest; reopening can recover the retained request.
Generic permission buttons cannot bypass source selection or mint a source receipt.
Source replies cross WatchConnectivity as encoded JSON Data, preserving explicit
nulls in host preview and recovery packets without invalid property-list values.
Source review starts with the latest exchange and supports older exchange pages.
Message and material pages accumulate without dropping selected IDs or revisions;
proposal, invocation, scope and overlapping bytes must remain unchanged. Materials
beyond the first hundred revisions use the host's original pagination cursor.
The existing WatchConnectivity page-size limit remains explicit; a page too large
for the relay reports an error rather than approving unseen or truncated material.

The separate Symposium artifact sealing/publication workflow is not a generic tool
permission and is unchanged. Its review notifications do not imply authorization.

## Validation and device acceptance

- Focused notification, permission, push-action and design regressions pass.
- Shared Swift approval/question/source-selection contracts pass.
- Offline Watch receipt integration passes.
- The complete Watch UI and both iPhone/Watch shared relay halves typecheck against
  their actual simulator SDKs without starting a simulator or contacting a server.
- Full shared Swift testing in this sandbox reports four failures in the unchanged
  platform certificate-trust fixture; approval tests pass. Notification HTTP tests
  cannot bind their local test listener under the current network fence.
- Browser layout tests do not render native SwiftUI. Native controls use system
  typography, semantics, toggles, secure fields and scrolling; no web palette,
  layout, motion or approved-design reference is changed. Physical layout,
  VoiceOver, dynamic text and notification presentation remain unverified.

Release acceptance still requires reviewed/accepted server and native sources,
an updated iPhone app with its embedded Watch companion, and a real locked-watch
test. Exercise native commands/files/permissions, task authorization, connected
services, once/session/conversation scopes, structured answers and source save.
Verify each Watch response settles the original pending request and resumes the
waiting agent exactly once. Include expired/changed requests, unavailable iPhone,
previews on/off and a transient source-save response failure. A merged PR or a
successful APNs send alone does not satisfy this acceptance.
