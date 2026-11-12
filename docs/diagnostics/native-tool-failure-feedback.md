# Native tool failure feedback

Verified against source revision `91d053fd47bc` and synthetic offline events on
5 November 2026. The reported incident contained a command ending after a
two-minute approval wait and later simultaneous transport losses. Logs did not
establish that a browser crash caused the shared disconnect or prove its
authentication trigger.

An expired native approval now refuses the operation with `decline` when the
request supports it. The original operation's abort still uses `cancel`, and a
request offering only cancellation retains that supported response. The final
delivery fence downgrades expired acceptance with the same rules and still
checks revocation, original ownership and path protection. No expired request
authorizes execution; retries require their own current approval.

Native command and runtime-tool display operations now close with an unknown
outcome when the owning turn ends before a result arrives. This is presentation
feedback, not proof that a child process stopped or that effects did not occur.
An unexplained final tool failure emits a durable message telling the user how
to continue. A later agent explanation or successful tool result suppresses that
fallback; recoverable tool failures do not automatically fail successful turns.

Retained authentication authority distinguishes `auth_expired` from
`auth_revoked`. The ordinary chat adapter preserves those reviewed reasons in
saved errors and telemetry instead of replacing them with a generic connection
failure. Existing expiry/revocation enforcement remains in place. Arbitrary
assertion text cannot become a public authentication diagnostic.

Focused regressions cover native approval expiry and delivery, fresh consent
after expiry, cancellation-only offers, interrupted command/runtime items,
ordinary continuation, adapter-to-query-loop feedback retention, authentication
expiry/revocation and repeated error reporting. These use synthetic events and
in-memory stores without browsers, live services, credentials or model calls.
The existing error-message component renders the feedback; no visual layout,
styles, navigation or approved design changes are introduced.
