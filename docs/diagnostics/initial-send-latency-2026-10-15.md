# Initial model send: OpenShell knowledge admission

This change removes repeated SSH startup from the ordinary OpenShell Codex
knowledge admission path. On the inspected baseline `e0feaf71`, a cold admission
used six sequential SSH exchanges; it now uses three. An unchanged warm admission
uses three instead of four. These counts exclude sandbox control-plane calls,
uploads, provider initialization and the separate task-capability inventory.
They are operation counts verified offline, not measured wall-clock savings.

## Earlier investigations

- PR #936 addressed navigation, authentication, replay and approvals. It also
  added bounded idle transport recovery and knowledge preparation spans.
- PR #942 made agent startup instructions reflect the runtime's available
  commands and made Telos retrieval conditional.
- The October 13 historical send investigation measured five new conversations
  taking 9.79–11.58 seconds from server receipt to provider dispatch. Healthy
  follow-ups spent a median 6.38 seconds preparing knowledge and the turn. Those
  observations used deployed `910b896018ca`; they do not benchmark current main.

## Change

The cache probe returns both integrity and physical entry presence in one
response. Missing entries and damaged entries remain distinct; dangling symlinks
count as present so the existing selected-cache repair can remove them.

Final content verification, optional default-context compilation and the existing
retention policy now run sequentially inside one remote command. Verification
failure stops compilation; compiler failure stops cleanup. A receipt is returned
only after every required child succeeds. The host validates the receipt and
compiled context, rechecks exact sandbox ownership/readiness and cancellation,
then retains the compiled context. The `knowledge.verify_delivery` span now
includes compilation and retention, replacing their separate remote phases.

Fresh publication reconciliation, mutable host verification, runtime attestation,
the lifecycle fence, all physical ownership reads and exact provider acceptance
receipts remain mandatory. Pinned profile context suppresses default compilation.
The retention policy still preserves the active view, manual pins, ten newest
views and views younger than thirty days. Cleanup runs before the final host
ownership read within the same admission fence.

## Verification and rollout

245 focused offline tests pass, including executing the generated shell/Python
commands on disposable files, quoted paths, content/mode/manifest tampering,
compiler failure, cache retention and repair, failed SSH delivery, wrong receipts,
missing/malformed context, ownership changes and cancellation. Server production
type checking, lint and formatting pass. No model calls were made.

The canonical staging check refused with uncertain custody on October 15. No
service, sandbox or staging configuration was changed. Live latency acceptance
requires the original-owner issue to be resolved through its operating procedure,
reviewed provider enrollment and an explicitly selected supported Luna model with
the exact charged account announced first. Production deployment is separate.

The remaining cold-start work includes sandbox creation, task seed upload,
publication reconciliation, remote knowledge upload, runtime/provider checks,
task inventory and native account/thread initialization. Measure their current
spans on qualified staging before selecting the next optimization. This patch
does not claim a complete first-send latency target or upstream model improvement.
