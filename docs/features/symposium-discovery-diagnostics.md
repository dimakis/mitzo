# Native model-discovery failure diagnostics

Discovery failures return an allowlisted diagnostic and `diagnosticPersisted` flag.
The retained host writes the same diagnostic to `model-discovery.json.diagnostic.json`
under the existing private journal lock, with mode 0600, file fsync and directory fsync.
The record contains a code-owned stage, conservative create-dispatch state, normalized
command failure class, optional numeric exit code, and timestamp. It never stores
command output, arguments, environment, account identity or credentials.

The original failure remains available after cleanup. A diagnostic write failure
is reported without changing allocation uncertainty. Nonzero exits and transport
loss never mean that create was not dispatched. Local ENOENT/EACCES without a child
PID describe only that command's spawn; they do not authorize clearing the durable
creation fence. Diagnostics confer no admission, cleanup or recovery authority.

This addresses erased failure details, not the missing explicit same-custody
recovery endpoint. A retained unknown create with no observed sandbox ID cannot be
cleared merely because a later inventory is empty. No automatic retry, gateway
adoption, sign-in, inference or cleanup is introduced.
