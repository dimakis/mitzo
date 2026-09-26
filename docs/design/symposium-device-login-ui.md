# Personal ChatGPT device sign-in UI

Connections and the Symposium account picker share the same device sign-in
control. Opening the control recovers the current authenticated operator session's latest receipt;
only **Get sign-in code** or **Reconnect ChatGPT** starts authentication. No
conversation is required from Connections.

The Mac host obtains an official device code. The phone can open
`https://auth.openai.com/codex/device` and enter that code after enabling device
code authentication in ChatGPT Settings → Security. The UI accepts only that
exact verification URL. The existing browser callback workflow remains an
explicit alternative in reviewer setup.

Pending receipt polling survives closing/reopening the control and page refresh
by reading the host receipt in the same authenticated session. Separately signed-in browsers cannot recover each other's pending codes. While the initial code request is still allocating, the UI polls for its pending receipt so cancellation remains available. Cancellation invalidates a late start response. The local attempt deadline is not a claim about
OpenAI's code expiry. Pending allocation may have no code yet. Failed, expired,
cancelled and restart-unknown states allow a fresh explicit attempt. Failed status
requests offer an in-place status retry; uncertain process cleanup blocks new
codes until host recovery. Cancel never implies provider authorization was
revoked.

Completion refreshes the reviewer account catalog and displays verified account
identity returned by the host. Connections lists multiple saved personal account
entries, each with its own label, verified identity, revision and status. Adding an
entry saves metadata only; Connect starts sign-in explicitly. Reconnect and
Disconnect target the selected entry and revision. They never select an account
for a reviewer or rebind existing seats. Saved metadata survives restart, but
credentials are not automatically restored: `reauth_required` appears as **Sign in
required**. `recovery_required` blocks new sign-in until host recovery. No auth URL, user code or
credential is persisted by the UI. Existing seat selections are never rebound.

Mocked tests cover recovery, cancellation, quarantined cleanup, polling from code
allocation through exact completion, official URL validation, and catalog refresh.
`ui-preview.html?view=connections` provides a fixture-only mobile preview; its
`DEMO-CODE` is not an actual OpenAI code. No live OAuth or model test is part of
this slice.

Before requesting a code, the UI explains ChatGPT Settings → Security and phone
troubleshooting: sign in to the intended account, then reopen the official device
page in the same browser. A provider page error is not treated as proof of expiry;
Mitzo's waiting deadline is labeled separately from OpenAI's code lifetime.

The account manager uses `GET/POST /api/symposium/personal/connections`, starts
login with `connectionId` and `expectedRevision`, filters status by `connectionId`,
and disconnects with the selected revision. The UI rejects another entry's
receipt and refreshes the list after terminal status or a mutation. Host
authenticated-session isolation and credential custody remain backend authority.
