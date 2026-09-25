# Durable reconnect: snapshot plus cursor

## Problem

Reconnect currently combines three independently timed views: a client-owned sequence cursor,
EventStore replay, and HTTP message restoration. Session and execution state may be inferred from
which lifecycle events happen to replay after the cursor. An ended session is especially fragile:
periodic delivery skips it, so a client whose cursor already passed the terminal event may keep a
stale running indicator.

## Target contract

EventStore owns one transactionally consistent reconnect boundary per session:

- `cursor` is the highest durable event sequence included in the boundary;
- `events` contains only durable events after the client's valid cursor and no event beyond the
  boundary;
- session lifecycle, execution generation, terminal outcome, and provider-attempt state come from
  the same SQLite read transaction;
- a client cursor beyond the durable high-water mark is reported as invalid instead of being
  trusted or silently replaying a duplicate transcript.

The server delivers the replay suffix followed by `session_reconnect_snapshot`. The snapshot is
authoritative for the client session state even when the suffix is empty. ConnectionRegistry then
advances to the snapshot cursor rather than inferring a boundary from the last event it happened to
send.

## Initial slice

The first slice adds `EventStore.captureReconnectState()`, moves WebSocket and SSE reconnect through
that atomic read, and teaches the client parser to consume authoritative lifecycle state. It closes
the ended-session stale-spinner gap and exposes execution/provider evidence for later reducers.

## Cursor-bound restore slice

The reconnect snapshot now carries the live pending-permission queue and the client records its
cursor explicitly, including when its previous cursor is invalid. REST transcript restoration takes
the snapshot cursor and reads only immutable events at or before that boundary. A later event cannot
enter an earlier transcript response. When the client cursor is invalid, it clears stale local
messages, fetches that bounded prefix, and preserves messages delivered after the new boundary while
the fetch is in flight. WebSocket and SSE use the same parser and reducer path.

The permission queue is an in-process interaction snapshot: after server restart, no provider
resolver remains to accept an old approval. Startup recovery must terminalize that execution rather
than presenting an approval that could no longer be applied.

## Typed in-flight transcript slice

Bounded REST restore now returns `{ messages, current }`. `messages` contains completed turns;
`current` contains the durable open assistant turn with ordered text, thinking, and tool blocks,
including partial content, completion flags, tool input, and available tool results. The response
is reconstructed solely from events through the requested cursor, including after a database
reopen. A terminal `session_end` closes any partial turn into history so it cannot restore a stale
streaming indicator. WebSocket and SSE snapshots use the same client reducer; a live event that
updates the current turn while the REST request is in flight takes precedence over the older
bounded response. The unbounded history endpoint retains its legacy array response.

## Remaining slices

1. Eliminate remaining unbounded foreground or session-switch history fetches.
2. Acknowledge snapshot cursors to the server only after client application, and cover dropped,
   duplicated, and out-of-order live events with bounded replay recovery.
3. Remove socket-presence and client-pending inference from restore decisions, then retire periodic
   replay as an authority (it may remain only as a delivery retry).
4. Extend disk-reopen integration coverage from bounded partial/terminal transcripts to active,
   requires-action, stale-cursor, and interrupted-replay boundaries across REST, SSE, WebSocket,
   and the mobile reducer.

Provider/account route migration, production deployment, and live model calls are outside this
phase.
