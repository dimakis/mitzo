# Mobile terminal and Minion

Open **More → Terminal** to resume the Mac shell, or choose **Terminal** in a chat’s composer tools menu to open that conversation’s environment. Both entries use the same page and the existing mobile masthead. Back returns to the conversation without ending the shell. Controls and Minion collapse independently, and the command area stays reachable when the phone keyboard opens.

The destination selector offers the Mac and a search over named chat sandboxes. It never accepts a client-supplied directory, gateway or sandbox ID. A sandbox must have a saved runtime receipt, unchanged account/runtime configuration and an observed Ready physical instance. Ambiguous multi-agent conversations require a specific agent destination and currently fail closed.

## Shell lifecycle

The host and eligible sandboxes need `tmux` on PATH. Mitzo attaches a node-pty client to its own tmux namespace. Navigating away only removes the output subscriber; application shutdown detaches clients while tmux preserves the shell. Reconnect and server reconstruction attach the recorded session. Ownership lasts for the authenticated login: logout or expiry closes its shells. Durable login leases and original cleanup receipts allow expiry reconciliation after server restart; uncertain cleanup retains capacity and retries without retargeting another sandbox. A missing saved shell never becomes a new shell implicitly. **End terminal session** ends it explicitly.

Terminal records live in the existing task-store database and are owned by the interactive login that opened them. A different login cannot list, read, write, resize or end those records. Limits are five running shells per login and fifty overall. Output replay is bounded. Logout and expiry close streams and cancel queued input before delivery.

Sandbox SSH uses the reviewed OpenShell v1 `CreateSshSession` wire contract to mint a short-lived grant for the saved **physical sandbox ID**, then uses token-mode `ssh-proxy`. Recycled names cannot redirect a shell. This requires the runtime’s explicit private CLI HOME and its verified mTLS gateway metadata. Unsupported authentication/configuration fails without a host or name-based fallback. The grant stays in the transport process; it is not stored in the terminal database or returned to the browser. The wire layout is pinned to [the reviewed OpenShell source](https://github.com/dimakis/OpenShell/blob/b4c459f92446167afcb0a2dcf7d9fa6c8945e59c/proto/openshell.proto).

The command area supports visible multiline drafts, explicit Run, Ctrl C, Esc and Tab, plus command recall and a history picker. Down restores an unfinished draft after recall. Suggestions and history fill the draft; they never execute it. Invisible terminal control characters are excluded from suggestions. History records only deliberate command-area submissions in the current app lifetime. Interactive login/password input goes directly through the TTY and is not added to that history.

## Adviser

Minion is collapsed initially. A chat supplies an initial account, model and thinking preference, independently of the terminal destination. Changing account or model starts a fresh adviser context; changing thinking retains the conversation. The shared AccountModelPicker supplies actual configured models and supported thinking choices without changing chat defaults. Gemini 3 uses supported named thinking levels. Gemini 2.5 adviser presets use budgets of 512 (low), 1024 (medium), and 2048 (high) tokens; Flash may also disable thinking. Unsupported choices, including minimal thinking without private thought signatures, are excluded from the adviser picker.

**Share output** prepares selected text or recent rendered terminal lines in an editable review field. Nothing is sent until Ask. Remove secrets there before sending. The adviser has no terminal service, agent loop, execution dispatcher or tools. It makes a single native inference request and returns text and optional editable command suggestions. Provider tool calls fail closed. OpenAI and Gemini adviser adapters accept the explicitly reviewed text transcript on subsequent turns; agent sessions retain their stricter private-checkpoint contract.

OpenAI API, Gemini Vertex and Claude Vertex accounts are supported. Personal ChatGPT subscription advisers remain unavailable: the existing CLI agent runtime does not establish a tool-free inference capability. Their saved eligible sandbox can still be the human terminal destination. No alternate account, model or host credentials are substituted. A subscription adviser needs a separately reviewed isolated adapter before enrollment.

**Settings → Appearance → Assistant name** controls the shared helper display name, defaulting to Minion, and updates mounted consumers and other tabs. It is saved on the device alongside existing appearance preferences. Future companion/adviser surfaces should use `useAssistantName` and identify their role separately.

## Acceptance and rollout

Unit tests use synthetic provider events and TLS gateway fixtures. The native smoke test uses a temporary HOME, `/bin/sh` and a unique tmux socket, preserving a shell value across backend reconstruction and cleaning up only its own resources. Offline browser tests intercept every request and serve compiled assets without a backend or preview server; they cover Safari, phone Chromium and desktop Chromium, masthead geometry, explicit command execution, reviewed context and keyboard layout.

Live acceptance must use the canonical staging procedure after source acceptance and independently reviewed provider configuration. Any real model test must select a supported Luna model and state the exact model and charged account before calling it. This feature does not authorize production deployment, provider enrollment or an additional staging instance.
