# First-command identity for repository-chat sources

Base: #1434 (`44ea03d82`). Running release at diagnosis: `main-805fbd9c9e4c`.

## Incident

A Symposium consult from a repository-workspace chat failed on both a Codex and
a Claude specialist route with `specialist_tool_failed`. Loki showed
`CollaborationContractError: snapshot_changed` raised by the durable transcript
capture (`collaboration-visible-source` initial-prompt check). Nothing was
persisted, so `read` and `recover` reported `Consultation request not found`
through the same opaque code. No specialist ran.

## Cause

`sessions.initial_prompt` carried two meanings. `_startChatInner` prepended the
repository preamble (and, for ordinary commands, reply/source assembly) to
`prompt` and stored that provider envelope as `initialPrompt`. The controller
stored the first `user_message` with the typed text. Every reader that located
the first command by text equality then disagreed with stored history:

- durable transcript capture and the reviewed visible source refused;
- the Telos conversation source refused for the same reason;
- canonical replay synthesized a second, envelope-text first message unless the
  Local Vertex custody projection repaired it first.

The workspace context already reaches every provider through the system prompt.
Non-ordinary Codex/native startups additionally stored the envelope as the public
first `user_message`.

## Contract

- `initialPrompt` is the public command text only. `initialMessageId` (new
  `sessions.initial_message_id`) is the durable identity of that first
  `user_message`, recorded by the writer that stores it (startup upsert and the
  query-loop path).
- Every start path stores the public text as the first `user_message`: the same
  text as before minus the workspace preamble. Context-block and source envelopes
  stay, because the Context-injected disclosure splits them back out
  (`docs/design/context-blocks.md`). Non-ordinary cold-resume commands use the
  same derivation, matching warm follow-ups, which never carried the preamble.
- `EventStore.getInitialCommand` is the single resolver. Recorded identity wins.
  A legacy row without it is repaired only when the session's own first ordinary
  send receipt names the first ordinary `user_message` with identical text;
  otherwise the stored text stays authoritative and mismatches remain refused.
- The visible source, durable transcript, Telos conversation source, REST replay
  and the session transcript reader (history, reconnect and full transcript) use
  that resolver. Replay matches an identified first command by `messageId`, so
  later identical text stays visible; legacy text-only rows keep their duplicate
  suppression. A recorded identity must be the first visible anchor. Changing the
  identity invalidates an opened source.
- The refusal now has its own code, `source_initial_command_unverified`
  (message `snapshot_changed` preserved), with a fixed public diagnostic through
  HTTP and specialist tools. A missing consultation reports
  `consultation_not_found` instead of `specialist_tool_failed`.

## Verification

Offline only; not deployment or live acceptance.

- `session-initial-command-identity.test.ts` reproduces the incident row
  (envelope `initialPrompt`, typed `user_message`, ordinary receipt). It fails
  with the receipt repair disabled and passes with it. It also covers receipt
  mismatch refusal with the new diagnostic, identity over repeated text, a
  misplaced identity, identity change invalidation and the not-found diagnostic.
- Updated expectations: the delayed legacy prompt refusal carries the new code;
  the legacy native REST, reader, discovery and Telos HTTP fixtures supply the
  resolver.

## Centaur review on `441da611b` (review 6058174368)

- `CEN-3FE094206A11` (blocking): the first `user_message` had dropped the
  context-block envelope. Fixed as described above. A native startup test with a
  context block asserts the envelope, `initialPrompt` and `initialMessageId`.
- `CEN-24F374C5C14E`: the session transcript reader now uses the resolver and
  replay matches by identity. A test of a receipt-repaired non-Anthropic
  repository chat fails without the reader change (phantom `umsg-initial`
  preamble message on history, reconnect and transcript) and passes with it. A
  replay test keeps later identical text visible under recorded identity.
- `CEN-A4660C119FFB`: write-path tests cover a real repository-workspace Codex
  start (typed text, no preamble, matching identity), the native startup upsert
  and echo, and the query-loop upsert/emit with a generated message ID.
- CI unit shard 1/4 failure on `1f10b67f5` (`todos.test.ts`, 503) was this
  change: its event-store fake lacked `getInitialCommand`. Fixed in the fake.
- Host runs of the transcript, collaboration, Telos source, specialist, query
  loop, startup, native/Codex conversation, repository chat, session and route
  suites pass. Some heavy end-to-end files time out under full parallel load
  and pass when rerun alone.
- Protocol and server TypeScript, changed-file ESLint/Prettier and regenerated
  reviewed source fingerprints pass (no runtime revision bump, per #1454).

## Not in scope

Workspace context is still also prepended to provider input for the first
command and ordinary follow-up commands. It is redundant with the system prompt
but no longer reaches public history or source identity; removing it changes
provider input and frozen first-command fingerprints, so it is a separate change.
