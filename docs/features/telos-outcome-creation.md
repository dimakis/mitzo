# Outcome creation from chat

On 5 November 2026, Dimitri reported that outcome creation and its button did not
work and that manually adding source messages was unusable. Source inspection
against main `79c334fa1e640372c1f5c54cf60b24bee50a1970` confirmed that saving
was disabled until the operator selected messages and separately compiled a
preview. The source picker opened on the oldest fifty anchors, making the current
exchange difficult to reach in a long chat. Initial read errors required denying
the request and invoking the tool again. This establishes those flow defects;
the screenshot alone does not establish the exact server error of the failed call.

Creation now requests the most recent bounded page and prepares the latest
eligible public exchange. It shows the outcome brief and exact compiled source
before one explicit **Create outcome** action. The optional **Change saved
context** disclosure retains earlier-message paging and material selection.
Unavailable messages are excluded from suggestions; no material is automatically
attached. The user can retry an initial read without creating another invocation.
Failure results remain visible outside collapsed activity. These changes use
PermissionBanner, native details, ToolResultContent and existing semantic styles,
spacing, type, control height and motion tokens; no palette or layout scale is added.

The existing host compiler, pending invocation, approval deadline, native authority,
canonical creation owner and retained receipt remain authoritative. Opening,
suggesting and previewing create nothing. Selection changes invalidate previews;
uncertain saves retain their original request for recovery. Existing explicit
source adoption and older forward-paging clients retain their contracts.

Focused regressions cover recent and earlier pages, one explicit save without
message picking, initial read retry, visible failure results and existing
approval/recovery/material fences. Shared packages compile with one worker and
a 1 GiB heap. The offline `telos-outcome-create` browser fixture uses real
temporary owners and intercepted requests for 320px phones and desktop, both
themes, Mint/System and Teal/Georgia, larger text, keyboard activation, reachable
44px actions, draft preservation and exactly one created item. It makes no model
calls and uses no production configuration.

Local browser execution remains unverified: the approved escalated launcher still
reported the macOS Seatbelt marker, so the repository guard refused before launch.
CI browser execution and visual inspection are required before UI acceptance.
No production deployment or live-incident recovery is established by these tests.
