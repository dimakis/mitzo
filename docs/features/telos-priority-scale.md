# Telos priority amendment

This adds the approved 1–10 item-header selector and matching `P<n>` badge to
the current Telos pages. It does not implement the later workspace redesign.
The existing navigation, sections, urgency ordering and other controls retain
their behavior. Numeric priority is independent of the legacy star compatibility
API and of Home pins.

## Approval and integration

On 17 October 2026, Dimitri approved the corrected preview in conversation
`01a14b56-e8c7-7e21-aafb-e9b5b63ae917`: “Fine. That works. Implement this and
only this.” The additive reference and approval are pinned in the
[design ledger](../design/approved/ledger.json). The original frozen r1 mock,
SHA-256 `97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`,
remains authoritative for the surrounding redesigned interface.

This amendment belongs with existing parent `85e8444019a4ae4a`, S7
`57b0894e0379ab95` (outcomes/item workspace) and S8 `b47a0c568f1d98ba`
(chat header/work tree). Those later slices must reuse the same field and
selector/badge behavior. S4 source was accepted in #1002; S5 delegation is
separate. These controls do not fulfill S7, S8 or the parent acceptance criteria.
This document is source evidence, not a live tracker update receipt.

## Data and failure behavior

The companion [MGMT PR #348](https://github.com/dimakis/mgmt/pull/348) owns SQLite migration and persistence. Existing
starred rows migrate once to 10, other rows to 5; new items default to 5.
Legacy manual source entries may seed their old star distinction or an explicit
numeric value. Source refreshes preserve an existing item's user-selected value.
Edits do not rewrite the manual YAML source. Both fresh and migrated databases
enforce integer values in 1–10.

Mitzo forwards `{ action: "priority", priority: 7 }` through the existing todo
action API. Missing numeric values on older list responses map starred items to
10 and others to 5, including nested items. Deploy the MGMT capability before
enabling the new editor in a running Mitzo host. An older backend can still be
read; an unsupported or rejected write remains visible as a save error.

`TodoPrioritySelect` reuses the native select, semantic tokens, inherited font,
shared control height and focus styling. It disables overlapping saves. The
confirmed value remains visible while saving; failures preserve it and announce
uncertainty without replaying a write. The existing list cache updates only after
confirmation and publishes it to every mounted list/detail consumer, including
the desktop split view. Writes to the same item are serialized across navigation
and remounts, so a delayed older acknowledgment cannot replace a newer edit.
A failed write does not prevent the next explicit edit. Item detail uses that
same data owner rather than a second list fetch. Reloads and navigation
revalidate the persisted value.
An item missing from a retained snapshot stays on its detail route until the
mounted read completes. A newly saved advisor child can therefore open while
the previous list is cached; a failed read retains the existing Retry state.
When a detail still uses its navigation snapshot, confirmed priority saves also
update that retained snapshot. Rejected saves leave it unchanged, and canonical
list data takes precedence whenever it becomes available.

The added database column participates in the existing item revision snapshots.
Ordinary role/delegation owners retain their existing revision conflict checks;
this amendment adds no dispatcher, task-priority mapping or runtime behavior.

## Evidence mapping

| Requirement                                  | Implementation and regression                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Header selector, 1–10 and `n / 10`           | `TodoPrioritySelect`, its functional tests and offline priority fixture                                                  |
| Matching recursive `P<n>` badge              | `TodoCard`, legacy/explicit-value tests, reload/back-navigation fixture                                                  |
| Durable validated values                     | MGMT priority migration/store/API/CLI tests; Mitzo todo route and schema tests                                           |
| No grouping, ordering or navigation redesign | Existing TodoView tests plus explicit grouping/urgency-order regression                                                  |
| Saving, rejection and uncertain response     | Confirmed-only hook tests; selector serialization/error tests; intercepted browser failure                               |
| Mobile and desktop usability                 | Offline WebKit/Chromium at 320px and Chromium at 1280px, light/dark, alternate fonts/accents and larger light-theme text |

The browser fixture renders the actual responsive `TodoWorkspace`, including
simultaneously mounted desktop list/detail panels, with intercepted
HTTP and an inert transport. It omits the surrounding application shell. Full
build, broader browser acceptance and review remain CI/review gates. It uses no
backend, live account, credentials or model calls.
