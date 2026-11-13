# Bounded current Telos reads

Use `TelosManageItem` with
`{"operation":"read","itemId":"…","view":"overview"}` for routine status
and coordination. It returns the current work level, parent, child counts, bounded
brief/criteria/child/update excerpts, lifecycle state, current assigned chats,
reporting target and execution observations. Canonical item and lifecycle revision
tokens remain exact and usable by the existing guarded mutation owners.

`truncatedFields` names every excerpted field/list. Counts describe the actual
read snapshot; `updatesInFullReadWindow` counts the existing recent-update window,
not all historical updates. Assignment and lifecycle history are omitted with
their counts. Missing runtime evidence stays unknown. No history, metadata or
assignment is rewritten, and the read starts no work or approval.

The response supplies an explicit `details` request with `view: full`. That view,
and the legacy read with no view, retain the complete existing response and its
lossless JSON-fragment paging. Overview does not accept a nonzero fragment offset.
For additional children use the existing parent-filtered `TelosListItems`; use
full detail only when a specific decision needs the omitted brief or history.

Previously a status check could require dozens of 8 KB pages because legacy
titles, updates and copied checkpoint histories dominated the response. The
overview keeps routine discovery to one read and preserves the original revision
token rather than hashing excerpts. Authorization, cancellation, lifecycle and
current runtime checks remain with the existing owners and are rechecked on each
invocation; this is not a cached authority or a new access path.

Telos links establish work responsibility and delegated creation/control scope.
Ordinary peer messaging remains independently authorized and does not require a
shared Telos family. An independent audit chat does not need adoption to message
another eligible operator-owned chat.
