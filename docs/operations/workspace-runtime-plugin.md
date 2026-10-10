# Workspace runtime plugin: first extraction

Calendar reads and saved morning briefing lookup can use a separately installed workspace runtime. Mgmt remains the knowledge/work location; executable Python does not need to live there. This integration does not start scheduled jobs, generate briefings, migrate todos, install runtime code into sandboxes, or change provider enrollment.

Set `MITZO_WORKSPACE_RUNTIME_CONFIG` to an absolute, physical, owner-private JSON file. An unset variable preserves the legacy routes; a set variable, including an empty or invalid value, selects the runtime and fails closed. It never falls back to executable files from mgmt after an enrollment failure.

```json
{
  "kind": "workspace-runtime-v1",
  "release": "/absolute/pinned-runtime-release",
  "releaseCommit": "0000000000000000000000000000000000000000",
  "python": "/absolute/venv/bin/python3",
  "config": "/absolute/private/runtime-config.json",
  "briefingsRoot": "/absolute/knowledge/command_center/briefings"
}
```

Both operator JSON files must be physical, owner-private regular files with exactly one filesystem link. Early shared path protection reserves them before any runtime request, so document/native file tools cannot edit enrollment, interpreter selection or provider configuration. Selected source releases, interpreter virtual environments, Jira code and provider executables are reserved against writes; their reads and execution remain governed by the existing policy, so a shared Homebrew interpreter stays usable by unrelated analysis tasks. Protection retains both selected link paths and physical targets for the process lifetime, including after re-enrollment or removal. Reports, inbox contents and domain data retain the existing document authority.

Native shell commands refuse writable task roots that contain or overlap these runtime authority paths; move enrollment and installed runtime/environment files outside task/workspace roots. This prevents ancestor-directory rename/delete and executable-link replacement from bypassing file-level protection. Inbox reads/archive/delete and listings use the same retained protection; approval checks both the source and archive destination. Every intermediate selected executable symlink entry is reserved against replacement, including links reached through aliased ancestors. Malformed, unreadable or hardlinked authority fails closed until repaired by the operator outside application file tools.

The commit above is a placeholder. Use an accepted, clean, detached release containing tracked `run-runtime.py`. Deployment tooling must independently establish acceptance and interpreter/dependency integrity. Each request compares every tracked source file's physical bytes and executable mode with its pinned Git object, rejects untracked files even when ignored, and checks the detached revision, index, configuration ownership and physical paths. Git replacement refs, include files, clean filters and external filesystem monitors are blocked; virtual environments and caches must be outside the release. Configuration changes require a newly created client; requests create one from the current operator enrollment. Credential values and raw process diagnostics are not sent through these routes.

The runtime configuration is also a physical owner-private JSON file, with explicit absolute `configPath`, `relationshipsPath`, `dataRoot`, `briefingsRoot`, `inboxRoot`, `jiraLibPath`, `gwsExecutable`, and `jiraLibSha256` (64 lowercase hex characters). `contexginUrl` defaults to `http://127.0.0.1:4195`. The briefing root must equal the enrollment value and already be readable under Mitzo's configured document roots. Enrollment does not expand file read or write authority; the initial output stays in mgmt's existing `command_center/briefings` directory. The runtime validates the pinned Jira source before importing it; it owns provider/source configuration independently from Mitzo.

The bridge executes only:

```text
<enrolled python> -I -B <release>/run-runtime.py --config <config> --operation <reviewed operation> --input <validated JSON>
```

The handshake operation is `runtime.describe`; it must return protocol `workspace-runtime-v1`, version `0.1.0`, and exactly `calendar.read` and `briefings.latest`. Each call has a shared 20-second deadline, owned process-group cancellation on client disconnect (including provider descendants), and an 8 MiB stdout/stderr bound. The environment is an explicit allowlist: home/path/temp/locale/user identity, Jira URL/email/API token, and Google Workspace CLI credential/token/config locations, keyring backend, OAuth client ID and client secret. These explicit authentication settings preserve existing file-keyring and OAuth-refresh configurations. Git ignores global/system configuration; shell, Python, Node and Git startup overrides are never inherited.

`calendar.read` accepts `{date, days}` and returns the existing calendar interval/events/sprints schema. Mitzo retains query defaults, the 1–31 day clamp, authentication and its existing unavailable calendar envelope. `briefings.latest` accepts `{date}` and returns null or `{filename, date, generatedAt, artifact}`. Artifacts must be a physical matching-date basename (`morning_YYYY-MM-DD_HHMM.md` or `YYYY-MM-DD.md`) under the enrolled briefing root. Mitzo maps this to the existing absolute `path` response so Today and the file viewer continue working. An unavailable briefing runtime returns HTTP 503, distinct from null.

This is operator enrollment, not an executable skill-marketplace installer. Descriptors, documents and model inputs cannot select arbitrary commands, modules, environments, roots or operations. Mutation capabilities continue using their existing approval/idempotency/verification/recovery pipeline.

Before deploying, compare both route contracts with deterministic fixtures, verify the external runtime independently, and follow the canonical staging procedure. Production deployment requires separate explicit authorization.

Host Claude SDK sessions also activate the outer OS filesystem sandbox when runtime authority has been observed, independently of Keychain enrollment. It denies confidential JSON reads and authority/pointer/parent writes for SDK and stdio MCP descendants. AppleEvents delegation to other applications is disabled so commands cannot move execution outside that fence. Controller-executed project hooks use the same protected worker, and local boot fallback commands select its runtime filesystem fence for every provider, including Codex, API and Gemini. Code/interpreter reads and ordinary report/temporary writes remain available. Runtime-only enrollment preserves project settings, hooks, MCP servers, provider environment and unrestricted networking; existing Keychain credential isolation retains its own settings and network restrictions. The runtime-only filesystem fence requires macOS and complete pinned sandbox dependencies; unsupported or incomplete isolation stops before spawning a provider or project command. Review these deployment requirements before activation.
