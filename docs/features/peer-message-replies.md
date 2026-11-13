# Peer replies across operator logins

An ordinary chat could send to a Telos worker, while the worker's correlated
reply failed with “Agent reply must address its original sender.” The tool and
permission owners recognized separately authenticated logins for the same
operator, but the durable message store still required identical login IDs.

The host now supplies its existing verified operator-ownership resolver at reply
reservation. The store still requires the exact reversed conversation pair, keeps
the actual replying login as provenance, and defaults to identical logins without
that host resolver. Current sender/recipient authority, permission grants,
revocation and runtime checks remain in their existing owners. Request replay
reads the original receipt and cannot submit a second message.

The regression reproduces the rejected reply before the repair, then exercises
the full tool and permission path for both Codex and Claude worker senders under
separate signed logins. The child retains a Telos assignment to a different lead:
general peer messaging is independent of the work-reporting relationship. The
regression also checks the original session grant and exact replay. Existing
isolation, denied/revoked permission, unsupported-runtime, active steering and
idle admission cases remain covered.

Default peer delivery uses `AgentCommunication`: supported busy peers receive
steering within their active turn. Explicit later delivery uses
`SendSessionMessage`, which queues until idle. An unavailable steering adapter
must produce an explicit limitation; it must not silently become delayed work.
Provider acceptance is delivery evidence, not proof the recipient applied an
instruction.

This reproduction establishes a source defect matching the reported one-way
symptom. It does not establish the exact production incident's login identities
or the cause of interrupted compaction. Source acceptance, release and live
verification remain separate steps.
