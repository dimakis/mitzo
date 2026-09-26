# Personal ChatGPT device sign-in UI

Connections and the Symposium account picker share the same device sign-in
control. Opening the control recovers the authenticated owner's latest receipt;
only **Get sign-in code** or **Reconnect ChatGPT** starts authentication. No
conversation is required from Connections.

The Mac host obtains an official device code. The phone can open
`https://auth.openai.com/codex/device` and enter that code after enabling device
code authentication in ChatGPT Settings → Security. The UI accepts only that
exact verification URL. The existing browser callback workflow remains an
explicit alternative in reviewer setup.

Pending receipt polling survives closing/reopening the control and page refresh
by reading the host receipt. The local attempt deadline is not a claim about
OpenAI's code expiry. Pending allocation may have no code yet. Failed, expired,
cancelled and restart-unknown states allow a fresh explicit attempt. Failed status
requests offer an in-place status retry; uncertain process cleanup blocks new
codes until host recovery. Cancel never implies provider authorization was
revoked.

Completion refreshes the reviewer account catalog and displays verified account
identity returned by the host. The host has one personal account slot; reconnect
replaces it, and host restart requires new sign-in. No auth URL, user code or
credential is persisted by the UI. Existing seat selections are never rebound.

Mocked tests cover recovery, cancellation, quarantined cleanup, polling from code
allocation through exact completion, official URL validation, and catalog refresh.
`ui-preview.html?view=connections` provides a fixture-only mobile preview; its
`DEMO-CODE` is not an actual OpenAI code. No live OAuth or model test is part of
this slice.
