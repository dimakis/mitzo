# Connection discovery in ordinary Claude chats

Ordinary Local Mac Claude chats can use `ListConnections` to inspect configured
Mitzo service connections and their current access state. Work Vertex and personal
Claude retain their existing account, SDK and workspace owners. Listing returns
the existing sanitized connection catalog; it reads no credentials, sends no
service request and grants no connection access.

The tool is optional in published profiles. Catalog eligibility, SDK exposure and
the ordinary permission callback agree on its identity. An explicit empty or
excluding profile cannot call it. Other connection operations, including access
requests, HTTP/WebSocket calls, setup and secret relay, remain unavailable on this
ordinary Claude route. The existing connection catalog and SDK callback boundary
are reused; no account registry or transport is added.

The first query, queued successor and cold continuation construct the same
supported surface. Current account/owner authority, callback lifetime, skill
policy and cancellation still govern execution. Revoked authority suppresses
delivery, and unexpected catalog failures retain a safe diagnostic reference.
An unconfigured connection service reports `keychainConfigured: false`; a listed
connection or existing access grant does not establish successful service reads.

Offline checks exercise real in-memory SDK/MCP transport with the connection store,
all three permission modes, profile selection, session-specific grants, negative
operations, cancellation, revocation and failure recovery. The existing joined
ordinary SDK-owner test covers Vertex and personal Claude, initial/queued/cold
queries and forged request refusal. Native SDK processes and external services
are simulated. No live account, model, service qualification or deployment is
claimed by these checks.

This is the first bounded integration under Shared Mitzo integrations
`20560449-8f72-41ea-9ebe-5f8c30d07d7f`, informed by the 12 November 2026 capability
baseline at accepted source `4b4153a86b55ce13b8daaa759e35fcb2798001b9`.
