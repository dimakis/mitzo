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
  and appends overlay entries, retaining base denials. Retaining a denial is not
  an immutable ceiling: a more-specific readable child can override a denied
  parent. Reject grants intersecting credential roots (including their ancestors)
  before forwarding them upstream.
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

## macOS kernel qualification

Run `node scripts/qualify-codex-native-permissions.mjs /absolute/pinned/codex`
outside any existing Seatbelt sandbox. It rejects an unqualified binary digest,
uses a temporary empty account environment and synthetic paths, and exercises
standalone `command/exec` without a thread, turn, account login or model call.
The checked-in JSON under `implementation-evidence/` records the actual outcome.

The base profile allows workspace writes and rejects outside writes. An otherwise
identical named profile with an exact extra writable root permits that action while
credential reads remain denied. This proves the configured kernel boundary can
change; `command/exec` has no `additionalPermissions` parameter, so it does not prove
the engine's `request_permissions` round trip or turn/session expiry. Those paths
need lifecycle adapter fixtures and the upstream source evidence above.

The literal-path control shows a more specific child read allowance can override
a parent denial. After an external actor retargets an approved symlink into a
credential directory, the next sandbox construction also reads that credential
through the retained literal allowance. The sandboxed unlink attempt itself was
blocked; the test labels external mutation separately. Private-root overlap
validation at approval time alone does not cover retained aliases after mutation.

The pinned macOS sandbox additionally supports absolute **deny globs**, emitted as
final anchored `deny file-read*`, `deny file-write*` and ancestor unlink rules in
`sandboxing/src/seatbelt.rs`, `build_seatbelt_unreadable_glob_policy`. Use POSIX glob
escaping independently of configuration serialization:

```js
const subtreeDenyGlob = (path) => `${path.replace(/[\\*?[\]{}]/g, '\\$&')}{,/**}`;
```

The brace alternative covers both the literal base path and every descendant.
Serialize that complete pattern as a TOML string key separately; the script uses
`JSON.stringify` for the key. Kernel controls cover literal `\\`, `*`, `?`, brackets
and braces in directory names, with a neighboring name remaining readable and
writable. They also cover a standalone credential file, hostile exact child
read/write allowances, symlink aliases, external retargeting across repeated
constructions of the same profile, and protected-directory/ancestor rename.
The exercised direct-path, symlink and rename credential controls remain denied
under the glob fence. This is a pathname qualification, not a universal inode
alias guarantee: [the follow-up alias controls](codex-native-alias-qualification.md)
show that host-preexisting hardlinks need distinct physical-authority assumptions.
This qualifies POSIX/macOS patterns only; it does not establish Windows escaping
semantics.

A whole-private-home deny glob defeats more-specific runtime read exceptions.
Actual native `apply_patch` arg0 symlinks under that home fail with both an outside
target executable and a copied executable inside the home, while positive controls
without the glob execute. Upstream `arg0/src/lib.rs` fixes their location at
`CODEX_HOME/tmp/arg0`; there is no separate supported helper-temp-root setting.
The pinned glob grammar has no direct subtree-exclusion operator. Do not invent a
complex complement pattern or weaken credential protection to make an alias work.

Direct native helper dispatch is different: the test copies the pinned executable
to `privateHome/codex-runtime`, denies the entire home with a glob, and supplies
no explicit helper exceptions. Execution succeeds while reading the executable's
bytes fails. The native `--codex-run-as-apply-patch` and
`--codex-run-as-arg0-exec-helper` subprocesses write the workspace successfully.
The real `--codex-run-as-fs-helper` protocol reads/writes workspace files and
returns errors for credential reads/writes. Its direct self-executable invocation
and JSON stdin payload match `exec-server/src/fs_sandbox.rs` and
`fs_helper_main.rs`. These controls explicitly disable `shell_zsh_fork`, enable
`unified_exec`, disable hooks, and clear legacy `notify`.

This supports further integration qualification of the direct native process and
filesystem route while leaving shell PATH aliases unavailable. It does not enable
that route, execute a model's `unified_exec` turn, qualify the configured host's
frozen binary identity, or exercise actual thread-grant expiry/resume.

## Source review of other execution paths

`core/src/tools/sandboxing.rs`, `with_cached_approval`, caches session approvals;
it does not cache an unsandboxed execution result. `tools/orchestrator.rs` still
computes `unsandboxed_execution_allowed` before execution and retry. Denied-read
restrictions prevent the execpolicy `Skip`/explicit-escalation sandbox bypass.
Scoped permission overlays retain the glob entries when constructing the next
effective profile. Retained process descendants inherit their kernel sandbox.
The built-in patch runtime passes an explicit effective filesystem sandbox
context to the native filesystem helpers.

This is not a claim that a model tool's fence covers every app-server subprocess.
`hooks/src/engine/command_runner.rs` spawns host hook commands directly. Legacy
`notify` is created independently of the hooks feature flag in `hooks/registry.rs`
and also spawns a host command; `features.hooks=false` alone does not disable it.
Require an empty/disabled `notify` configuration separately. MCP servers, host
tools and integrations have their own execution authority and are not qualified
by these kernel controls. Keep unqualified paths disabled; do not silently route
failed native operations through them.

## Other pinned capability findings

The public `thread/start` and `turn/start` schemas have no universal tool allowlist
or `toolChoice` ceiling. An empty dynamic tool list plus disabling shell, unified
execution and web does not establish a tool-free adviser. The internal Rust
`ext/extension-api/src/tool_policy.rs` supports startup
`ToolPolicy { allowed_tools: Some(vec![]) }`, with reinjection on resume; the
`core/src/tools/spec_plan_tests.rs` test
`allowed_tools_filter_sources_before_code_mode_and_discovery` covers core, MCP,
dynamic, hosted and code-mode tools. The public App Server RPC does not expose that
extension policy. Treat complete no-tools execution as unsupported until a reviewed
bridge provides it.

`DynamicToolCallResponse` supports `{contentItems,success}`, with items
`{type:"inputText",text}`, `{type:"inputImage",imageUrl}` and
`{type:"inputAudio",audioUrl}`. In
`app-server/tests/suite/v2/dynamic_tools.rs`, a valid inline PNG reaches model output;
`dynamic_tool_remote_image_response_becomes_model_visible_error` proves HTTPS
images fail. Use validated inline bytes, with an explicit product size cap.
Native MCP content conversion in `protocol/src/models.rs` preserves image
`data`/`mimeType` as an inline URL and honors `_meta["codex/imageDetail"]`.
These are source qualifications, not real-model tests or multimedia implementation.

## Runtime scratch directories

The agent profile explicitly grants `:tmpdir` and `:slash_tmp` write access for
ordinary shell scratch files, including zsh heredocs. Ask keeps these read-only.
Workspace roots, disabled networking, runtime read protection and the final
credential deny globs retain their existing policy. Temporary directories are
scratch space rather than additional task workspaces.

New native receipts record `temporaryAccess: runtime`, and the profile revision
includes this scope. The shared revision calculation validates both this profile
and historical receipts without that field; old receipts are never rewritten to
claim the new access. Existing in-flight policy refresh rules still apply.

The pinned no-model macOS qualifier exercises a heredoc large enough to require a
temporary file: the old profile refuses it, the scratch profile succeeds, and
credential reads and unrelated writes remain denied. This is standalone sandbox
qualification, not a live provider or browser acceptance result.
