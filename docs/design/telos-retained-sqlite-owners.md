# Retained owners for permanent Telos deletion

This change implements the concrete host contract on accepted `3f6c6aea`.
The actual App enables permanent deletion only for a fresh family created by
`createFreshTelosDatabaseFiles`, opened by the actual owners and continuously
retained through deletion. Existing or unknown data roots remain unqualified.
Archive, recoverable Trash and Restore retain their existing behavior.

## Authority comes from the actual file creation and owner lifetimes

The required authority is retained ownership of the three selected physical
files: canonical Telos, the actual chat EventStore and the actual App TaskStore.
The existing constructors cannot retrospectively establish that history.

The host-only creation operation for these exact selected paths creates all three files exclusively, captures their real descriptors and physical
identities before any SQLite connection opens, and retains an authenticated birth
record under a newly created private owner directory. It refuses if any selected
file, sidecar, super-journal, overlapping family path or earlier owner record already exists. It is an actual new-file operation,
not an enrollment of existing data, a schema migration or an availability flag.
The canonical Python owner still initializes and owns the canonical schema.

The creation operation is never called by App startup. Startup only verifies
retained history. Missing, malformed, copied, incomplete or invalidated history
remains unavailable; matching names, schema, timestamps, UUIDs, watermarks or a
newly written startup record cannot promote it. No actual user data is created,
adopted, deleted or moved as part of implementing or testing this contract.

A birth record is not sufficient by itself. Each actual constructor uses the
same narrow opening helper, which captures a descriptor before opening SQLite
and binds that capture to the actual opened connection. The binding checks both
the retained physical identity and SQLite's own current-file observation. The
helper never accepts an already-open connection or a caller's identity assertion.
An observed loss/replacement invalidates the retained history and cannot be
cleared by restoring the filename or restarting App. A closed owner never
regains authority; a subsequent assembly needs valid retained file history and
new captures from the actual constructors.

The new owner is specific to these three files. There is no generic registry,
cohort-available flag, parallel canonical database or provider-selected permit.

## The actual SQLite handle must agree

A small native workspace helper exposes the supported
`SQLITE_FCNTL_HAS_MOVED` check on the connection supplied by SQLite itself. It is
a current-handle denial check, **not a sticky historical certificate**. Unsupported
VFS results are unavailable. A Node pathname stat alone cannot replace it.

The same helper owns one native descriptor for the selected owner's exclusion
file. It uses nonblocking POSIX record locks. Leases are confined to the process
main thread, including open, lock, close and finalization. Worker environments
cannot acquire a lease; publishing the SQLite API table is atomic independently.
There is one such descriptor per App process; opening/closing another descriptor for that exclusion file is not
part of the supported owner interface. Normal owner lifetimes retain a shared
lock, and deletion requires a successful exclusive conversion. Another retained
process, a failed conversion or an unsupported platform denies deletion.

The existing actual owners acquire their captures at construction and invalidate
them on close. Their SQLite objects are never swapped after capture. All actual canonical
connection owners (Work, Item, Artifact and SourceApproval), EventStore and
TaskStore share the same fixed-family descriptor lifetime. Auxiliary descriptors
close only after the final managed SQLite connection for that role closes.
Unsupported environments and failed retained-family admission reject before
opening SQLite; they cannot leave an untracked connection behind. WAL is the
supported deletion mode, established by the existing canonical owner. The helper
observes that mode and never changes a read-only owner into a writer. Ordinary
reads on legacy roots remain available; this contract does not introduce a
schema writer into the corrected read-only paths.

## Check and deletion share one retained scope

The real App callback captures its selected canonical path and actual
EventStore/TaskStore objects. The real chat setter tracks installation changes;
restoring the old TaskStore object cannot restore an earlier installation token.
No callback, owner object or available flag is supplied by the fixture or client.

Inside the original Store's existing fresh deletion callback, the host:

1. Checks the original writable frame, current selected path, retained physical
   family and actual installed chat owners.
2. Obtains the real owner exclusion fence.
3. Starts its own immediate read scopes on the actual EventStore and TaskStore;
   pre-existing transactions are rejected rather than borrowed. Private
   SQLite savepoints verify the original transactions remain present; a committed
   and restarted transaction cannot replace them. These markers supply transaction
   retention only, separately from physical file authority.
4. Reads every retained role/task binding through the complete existing readers.
   Missing, malformed, referenced or unsupported state denies deletion.
5. Registers an opaque, original-invocation-bound fence with the original Store.
   It rechecks physical/current-owner state and complete references before the
   canonical commit, and releases all reference scopes and exclusion only after
   the canonical transaction has committed or rolled back.

The existing callback-only writer assertion remains callback-only. The new
transaction-lifetime fence is a separate private scope; it cannot authorize a
later item, borrowed transaction, new request or external host. Cleanup failure
after an already committed receipt must not falsely report that deletion did not
occur; invalidate future ownership and retain the committed outcome.

Auth, fresh typed confirmation, revision, leaf/reference checks, descendant
retention, materials, immutable receipts and exact retries remain existing owners.

## Required falsifiers and actual App boundary

Focused tests must exercise the real new-file creator and constructors, never a
test certificate or `assertQuiescent` stub. Cover existing/unknown roots, forged
new flags or IDs, copied records/files, unsupported observations, file loss,
replacement and restoration, closed owners, changed canonical selection, changed
chat installation including change-back, borrowed transactions, independent
writers, revoked auth and reentrancy. Failed checks preserve the item and data.

The retained genuine HTTP RED used App's missing callback: a correctly owned private unreferenced trashed
leaf still receives refusal. Install the real callback for GREEN, verify the
actual removal, intentionally lose the committed response, restart the private
App with the same data/auth and recover the identical receipt after a real record 404. Existing/unknown/lost families stay denied. Core owns focused server checks;
S9 remains the sole actual browser/App acceptance executor.

The native helper is a focused dependency, not a local Rust build or a new live
target. All tests use private data, one worker, a 1 GiB heap and zero model calls.
Build and packaging changes are reviewed with the affected owner contract; no
protected checks, accepted references or existing recipes are weakened.

Primary contracts: [SQLite file control](https://sqlite.org/c3ref/file_control.html)
and [Apple POSIX record locks](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html).
