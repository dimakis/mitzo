# Lost custodian recovery and retirement boundary

The running custodian is the only owner of its private gateway issuer, management
token, original process handles, native attempt registry and physical cleanup
capabilities. A replacement process cannot reconstruct those capabilities from
PIDs, SQLite rows, a copied TLS directory or a matching gateway name.

| Boundary                                      | Authority still available                                               | Supported action                                                                                                                                                                                   | Remaining gate                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| App child exits while parent and gateway live | Original parent and issuer                                              | Parent fences the controller epoch, revokes child authorization, suspends active memberships, drains exact runtimes, then starts a new app child only after reconciliation confirms.               | Disposable crash drill and physical proof.                                                     |
| Gateway child exits while parent lives        | Parent retains ledgers but its gateway capability fails custody checks. | Keep operations fenced; inspect retained identities and exact physical state. Do not switch the same session to another gateway.                                                                   | A supervised loss signal and confirmed sandbox/volume reconciliation are needed.               |
| Parent dies abruptly                          | No original process-local authority survives.                           | Keep old reservations and volumes. Run the read-only lost-custody report; an absent or conflicting terminal receipt keeps shutdown unconfirmed. Arrange a fresh authenticated operator inspection. | Exact physical cleanup or export with independently authorized retirement remains unsupported. |
| Host reboots                                  | No original process or issuer survives; process metadata is stale.      | Treat every old membership, sandbox and artifact as retained until fresh physical inventory and operator decision.                                                                                 | Reboot drill, independent auth, stale-owner fencing and physical disposition remain unproved.  |
| Live parent receives orderly shutdown         | Original parent and gateway remain available through drain.             | Durable controller-loss suspension precedes exact runtime stop; only confirmed cleanup and gateway exit permit an exclusive terminal receipt.                                                      | Physical rehearsal on a disposable fixture.                                                    |

After a suspected parent or reboot loss, build the server and run:

```text
node scripts/symposium/report-lost-custody.mjs ABS_EVENTS_DB ABS_STATE_PARENT
```

The paths are the selected repository's private `.mitzo/events.db` and the
private `gateway.stateParent` used by that custodian. The command opens the
EventStore, session artifact and artifact lease ledgers read-only, rejects
missing or unowned ledgers (and non-private owned-host ledgers), and emits current membership generations,
non-stopped sandbox identities, volume reservations, leases and pending-fence
counts. The original parent writes `custodian-retirement.json` only after
runtime and host drain plus exact gateway exit. The report checks that receipt
against retained artifact custody, current membership/sandbox/fence state and
other gateway launch directories. An absent, invalid or conflicting receipt
reports shutdown unconfirmed. A matching receipt records the original owner's
past orderly close; it cannot authenticate a new owner. The report omits
credential and request bodies. It makes no gateway or Podman call and always
reports physical proof unavailable. The output is an assessment,
not permission to restart, adopt, clean, export, reuse capacity or mark a
membership reconciled. Missing physical IDs and uncertainty remain visible.

An actual retirement tool still needs fresh authenticated operator authority,
independent exact sandbox and volume inventory, confirmation that no stale owner
can dispatch, a durable per-resource intent/receipt, and a way to preserve or
export artifacts before final disposition. Until those exist, retain the old
volumes and quarantine uncertain operations.
