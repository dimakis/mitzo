# Automatic closeout durable admission

Automatic inactivity closeout is an internal command, not an ordinary client send. It uses the
shared EventStore execution and provider-attempt lifecycle without claiming a wire-level client
command ID.

## Episode identity

The session registry creates one opaque episode ID when a detach timer enters closeout. Repeated
work inside that lifecycle episode keeps the same ID. Reattachment clears it, so a later detach
creates a distinct episode. User close creates a user episode when none exists; if it overlaps an
automatic episode, it shortens the lifecycle but does not inject a second prompt.

The internal message ID is a hash of the session and episode IDs. Its versioned admission
fingerprint binds the episode source, prompt/template revision, intended task, model, reasoning
selection, account/provider identity, and route-profile revision. No raw credential or private
endpoint is persisted.

## Admission and dispatch

The root execution is admitted before runtime queue persistence or a public user-message echo.
Exact retries return the original receipt and do not enqueue, echo, or dispatch again. A changed
source, template, task, model, or route conflicts before those side effects. An unresolved session
is not eligible for closeout admission, and an active EventStore execution is fenced rather than
overwritten.

Each runtime owns its real dispatch boundary:

- Codex app-server persists the stable command in its private FIFO, then begins the provider
  attempt immediately before `turn/start`.
- Native Responses prepares its private command, then uses the existing provider-admission token
  when the input queue reaches it.
- The fallback streaming SDK records the provider attempt before injecting the retained input and
  terminalizes it on turn completion or abort.

Cancellation fences late results. A restart never injects a closeout prompt. Orphan recovery marks
an undispatched root as a safe failed startup and a dispatched attempt as ambiguous; retrying the
same episode never repeats paid work. A genuinely later detach has a new episode ID and may admit a
new closeout after the previous root is terminal.

## Boundaries

This slice does not redesign reconnect snapshots, transport replay, account routing, or deployment.
Session-index closeout metadata remains a summary sink, not execution authority. Automatic closeout
still uses its existing prompt and timeout; explicit user close retains its shorter timeout and
distinct prompt when it starts its own episode.
