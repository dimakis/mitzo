# HA spoke inventory access

`HomeAssistantInventory` searches the existing HA spoke's private hardware cache.
It is a read-only connection tool available to API and SDK chats through the
same runtime registry as `ConnectionRequest`. It does not execute spoke code,
copy credentials into a sandbox, contact HA, or create a second inventory store.

## Host configuration

After reviewing and accepting the HA spoke and Mitzo changes, the host operator
creates the spoke cache using its existing HA client configuration:

```sh
python scripts/inventory.py refresh --section all
python scripts/inventory.py read --search echo
```

Configure Mitzo with an explicit map from saved connection ID to the absolute
spoke inventory file. This binding asserts that the cache belongs to that saved
connection; Mitzo never infers ownership from a friendly label or hostname.

```text
MITZO_HA_INVENTORY_FILES={"<saved-ha-connection-id>":"/absolute/spoke/context/inventory.json"}
```

This is host configuration, never a model-supplied path. Each file must be a
regular file owned by the Mitzo process user, inaccessible to group/other users,
at most 8 MiB, and not a symlink. The spoke refresh writes mode 0600 atomically.
The cache remains gitignored and does not enter the knowledge publication.
Unconfigured installations continue to work; `ListConnections` reports
`inventoryAvailable: false` and the inventory tool returns `inventory_unavailable`.
No configuration or deployment is performed by this change. Follow the normal
reviewed production activation process; staging on this Mac remains stood down.

## Tool behavior

```json
{ "connectionId": "<saved-ha-connection-id>", "search": "echo", "limit": 10, "maxAgeHours": 24 }
```

Requires the exact chat's connection grant and GET permission. Runtime ownership,
revocation, current permission and connection revision are checked before and
after the file read. The credential vault is never read. Results expose the
spoke's manufacturer, model, hardware/software versions, names and device/entity/
area links. Search inspects all metadata before selecting matches, so a device
named Shona can match Echo Show. Snapshot version 1 is defined by the HA spoke's
`lib/inventory.py` and `context/inventory.md`; both repositories test the same
synthetic contract fixture.

Results report section timestamps and ages, staleness, missing sections, match
count and truncation. Default limit is 10 (maximum 50); result size is capped at
16 KiB. Device links are capped at 20 entity IDs and 10 area names, each with its
own truncation flag. A missing/invalid devices registry is an error rather than
zero matches. A stale cache does not prove current device absence or state.

Refresh is explicit on the configured spoke host: `--section devices` refreshes
hardware metadata without fetching entity states or replacing other section
timestamps. API Bash cannot refresh the host file or access the spoke's `.env`.
When refresh is needed, explain that requirement; do not retry `/api/states` or
install a client in the sandbox. After a successful host refresh, the next tool
read sees the atomically replaced file without restarting Mitzo.

## Connection request failures

Safe errors are JSON with `error.code`, `message`, `retry` and `mayHaveApplied`.
Messages are fixed and never retain raw errors, response bodies or credentials.

| Code                                               | Next step                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `response_too_large`                               | Narrow the request or use the inventory; unchanged retries cannot help. |
| `authentication_failed`                            | Update the credential through secure setup.                             |
| `access_denied`                                    | Correct account permissions.                                            |
| `destination_blocked`, `redirect`, `tls_failed`    | Correct the connection address, network policy or certificate.          |
| `timeout`, `network_failed`, `service_unavailable` | A read may be retried later.                                            |
| `cancelled`                                        | Resume only under current session authority.                            |
| `inventory_unavailable`                            | Configure or refresh the spoke cache on its host.                       |
| `request_failed`                                   | Inspect configuration before repeating the request.                     |

Failed writes are conservatively marked `mayHaveApplied: true` with
`retry: verify_state`; never replay them automatically. WebSocket and dashboard
write-specific unconfirmed-operation protections remain in place. The generic
HTTPS response limit stays at 64 KiB: this feature avoids inserting a full
inventory into model context instead of increasing that limit.
