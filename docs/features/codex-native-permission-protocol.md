# Pinned native permission protocol

Qualified offline against the official `rust-v0.160.0` macOS ARM64 executable
(SHA-256 `112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`).
The checked-in reduced fixture retains generated experimental TypeScript declarations
and synthetic wire examples. Generation used an empty temporary `CODEX_HOME`:

```sh
codex --version
codex app-server generate-ts --experimental --out <schema>
```

The executable and source are public release artifacts from
[upstream rust-v0.160.0](https://github.com/openai/codex/tree/rust-v0.160.0).
No login, real credentials, model calls or provider requests were used.

`codex-native-permission-protocol.ts` validates wire data; it does not authorize
operations or implement another approval loop. Consumers must preserve the owning
runtime/account/thread/turn, JSON-RPC request ID, item ID and optional distinct
`approvalId` (stdin and exec-bridge subcommands can share an item).

| Request                                 | Response                                | Enforcement meaning                                                                                                                                    |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item/commandExecution/requestApproval` | `{decision}`                            | Accepts the waiting command; `additionalPermissions` identifies its requested overlay. An acceptance alone does not grant new filesystem roots.        |
| `item/fileChange/requestApproval`       | `{decision}`                            | Accepts the waiting patch. Generated `grantRoot` documentation explicitly says its session behavior is unclear; it is not evidence of a durable grant. |
| `item/permissions/requestApproval`      | `{permissions,scope,strictAutoReview?}` | Grants exact requested permissions with `turn` or `session` scope. Empty `permissions` denies.                                                         |

Command decisions include `accept`, `acceptForSession`, `decline`, `cancel`, and
execpolicy/network amendment objects. File decisions exclude amendment objects.
Exposing or accepting every protocol-valid decision is a separate product policy.

Permission requests contain nullable `network` and `fileSystem`. Responses use
optional fields instead. Filesystem overlays contain nullable `read`/`write`
arrays and optional `entries`/`globScanMaxDepth`. Entry access is `read`, `write`
or `deny`, with path, glob-pattern or special-path selectors. These are camelCase
wire fields, distinct from the snake_case configuration/model tool schema.

Native source evidence (paths relative to upstream `codex-rs/`):

- `core/src/session/mod.rs`, `normalize_request_permissions_response`: intersects
  granted and requested permissions; strict automatic review with session scope
  grants nothing. `record_granted_request_permissions_for_turn` records grants
  against the originating turn and environment, or the session and environment.
- `sandboxing/src/policy_transforms.rs`,
  `merge_file_system_policy_with_additional_permissions`: clones the base policy
  and appends overlay entries, retaining base denials.
- `core/src/tools/sandboxing_tests.rs`,
  `deny_read_blocks_explicit_escalation_and_policy_bypass`: deny-read restrictions
  prevent unsandboxed escalation; additional permissions keep sandbox enforcement.
- `sandboxing/src/seatbelt.rs`: builds native macOS file-read denials and appends
  them after broader allow rules. Source qualification alone does not prove a
  particular host executable/home configuration works through the kernel.

Named config profiles use `default_permissions`,
`permissions.<name>.filesystem` (path to `read`/`write`/`deny`), and
`permissions.<name>.network.enabled`. `thread/start` selects `permissions` instead
of `sandbox`; `turn/start` selects it instead of `sandboxPolicy`. Both support
`approvalsReviewer` (`user`, `auto_review`, legacy `guardian_subagent`). Native
review uses `item/autoApprovalReview/started` and `/completed` with stable review ID,
target item (nullable), action, outcome and rationale. Terminal outcomes include
`approved`, `denied`, `timedOut`, `aborted`. These events describe review, not a
second Mitzo grant. `serverRequest/resolved` identifies a completed/stale callback.

Automatic review availability, selected reviewer model/account/billing, and
actual provider execution remain unqualified by these offline schema fixtures.
Consumers must surface unavailable review and offer explicit human review rather
than assume approval. Transport loss or recovery must not replay uncertain effects.
