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

## Remaining slices

1. Replace the independent HTTP history fetch with a typed transcript snapshot tied to the same
   cursor, including in-flight message blocks and pending permission state.
2. Make WebSocket and SSE clients persist and acknowledge snapshot cursors explicitly; recover an
   invalid or compacted cursor by replacing local state from the durable snapshot.
3. Remove socket-presence and client-pending inference from restore decisions, then retire periodic
   replay as an authority (it may remain only as a delivery retry).
4. Add disk-reopen integration coverage for active, requires-action, terminal, stale-cursor, and
   interrupted-replay boundaries across REST, SSE, WebSocket, and the mobile reducer.

Provider/account route migration, production deployment, and live model calls are outside this
phase.
