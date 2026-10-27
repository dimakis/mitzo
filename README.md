# Mitzo

A self-hosted workspace for AI conversations and agent-assisted work, accessible
from your phone or desktop browser, with an optional native iOS app.

Mitzo brings chats, files, reusable agent profiles, knowledge and tracked outcomes
into one interface. It has integrations for ChatGPT subscriptions through Codex,
OpenAI API accounts, and Claude and Gemini through Vertex AI. The accounts, models,
tools and execution environments available to you depend on your installation.

## What you can do

- **Chat and work with agents.** Stream responses, inspect tool activity, approve
  actions and return to saved conversations from mobile or desktop.
- **Work with files and repositories.** Browse and edit documents, attach images,
  and opt into repository-backed chats with isolated working copies.
- **Reuse guidance and knowledge.** Publish agent profiles in the Agent Library,
  select existing tools for supported sessions, or assign recoverable task drafts;
  schedules remain paused. Select reference material from the Knowledge Library.
- **Track work.** Use Telos to organize outcomes and milestones, connect sessions
  to work, and record progress and evidence.
- **Connect services.** Review account and service access in Connections. Eligible
  installations can connect GitHub, Jira, Google Workspace and authenticated APIs.
- **Bring in another perspective.** Invite independent contributors to selected
  work through the configured collaboration routes.

Voice, push notifications, iOS/Watch support, managed connections and sandboxed
execution require additional services or host configuration. Provider and runtime
features have different limits; an option in source code is not proof that it has
been enabled and verified on your host.

## Conversation library

On desktop, **Chats** automatically previews saved history in a resizable right-hand
pane. **Open conversation** enters the chat. Hold on iOS, right-click on web or use
Shift+F10 for consistent actions, including in the desktop chat sidebar.

**Pin conversation** creates device shortcuts in a collapsible Pinned group: four
rows stay visible and additional pins scroll. **Pin to Today** remains a separate
workspace pin. Repository paths live in session details; work links require a
recorded Telos task association.

Today shows each session's latest recorded context count and percentage when a
current model limit is known. Cumulative tokens remain separate in details.
**Settings → Appearance → Show session context on Today** controls both recent
sessions and Today pins on this device. Missing counts and stale or unknown limits
are labelled explicitly. Previewing saved history never starts a provider turn.

## Before you install

Mitzo is under active development. The deployment tooling targets macOS, and
installation currently requires command-line setup and operator-owned account
configuration. There is no complete first-run installer yet.

You need:

- **Node.js 24+ and npm 11.18.0+**, plus Git.
- A workspace directory for files and state; use an existing Git repository for
  repository workflows.
- An explicitly configured AI account and an execution route compatible with it.
  Installing Mitzo does not sign you into a provider or configure billing.
- For native dependencies, the build tools required by your platform.

The older [onboarding guide](docs/onboarding.md) contains useful optional setup and
configuration examples, but its prerequisites, account instructions and deployment
steps predate the current runtime. Use the requirements here and the focused
account/runtime guides below when setting up a new installation.

## Build and run locally

These commands are for a standalone installation. On the configured Mitzo
development Mac, canonical staging and its pipeline are stood down. Use offline
tests, review and CI; live testing requires a separately authorized target. The
[retained staging procedures](docs/operations/canonical-staging.md) are historical,
and reactivation requires a new explicit request. Do not borrow production
configuration or start another backend against it.

```bash
git clone https://github.com/dimakis/mitzo.git
cd mitzo
npm install
cp .env.example .env
```

Edit `.env` before starting:

| Setting           | Purpose                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `AUTH_PASSPHRASE` | Your Mitzo login passphrase; replace the example value.                                      |
| `AUTH_SECRET`     | A random signing secret of at least 32 characters; generate one with `openssl rand -hex 32`. |
| `REPO_PATH`       | Absolute path to your workspace.                                                             |
| `MITZO_BIND_HOST` | Set to `127.0.0.1` for access only from this Mac.                                            |
| `PORT`            | Defaults to `3100`; choose an unused port if needed.                                         |

Then build **both the server and frontend**, and start the compiled server:

```bash
npm run build:all
npm start
```

With the example port and no certificates configured, open
`http://localhost:3100` and log in with your passphrase. If you configured TLS,
use HTTPS and a certificate trusted by the client device.

This gets the application running. Configure an account and its runtime before
expecting a chat to execute. A successful build or login does not verify provider
access.

## Accounts and your first conversation

Accounts are configured on the server. `MITZO_ACCOUNT_PROFILES_FILE` selects an
explicit account catalog; credentials remain in the server's private credential
storage. Available models and routes are specific to each account.

| Setup                                         | Guide                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ChatGPT subscription through Codex            | [Account configuration and native chat lifecycle](docs/features/codex-app-server.md)                      |
| Add an OpenAI API account through Connections | [Enrollment prerequisites, billing validation and setup](docs/features/openai-account-enrollment.md)      |
| Local Mac and OpenShell conversation routes   | [Runtime selection, configuration gates and current limits](docs/design/session-runtime-selection.md)     |
| Local Claude through Vertex AI                | [Claude route configuration and qualification status](docs/design/ordinary-local-vertex-source-status.md) |
| Local Gemini through Vertex AI                | [Gemini route configuration and qualification status](docs/design/ordinary-local-gemini-source-status.md) |

These are operator setup guides. New-account enrollment and ordinary runtime
routes are gated and need their documented host configuration. A local provider
login does not automatically enroll that account in an OpenShell runtime.

Once your account and route are configured:

1. Open **New chat** and expand the summary above the composer.
2. Review **Agent**, **Account**, **Model**, **Thinking** and **Run on**. Confirm
   the account you intend to use; ChatGPT subscription and API billing are separate.
3. Start with a simple request, such as “Help me turn these notes into an action
   plan.” Repository access and service connections can be added when needed.
4. Review permission requests as they appear. Check **Access** for the session's
   configured connections and available evidence.

Conversations retain their account and workspace identity. Start a new
conversation to use a different account or environment. Supported model changes
apply to future commands; already running or queued commands keep their settings.

## Use Mitzo from your phone

First confirm the application works on the host. For private remote access,
install [Tailscale](https://tailscale.com/download) on the host and your phone,
configure a reachable listener, and use the host's tailnet address.

Tailscale encrypts network traffic. HTTPS is still required for browser features
that need a secure context, and native clients require a certificate trusted by
the device and valid for the configured hostname. See the
[certificate and mobile setup notes](docs/onboarding.md#step-3-generate-https-certificate).
The [iOS build notes](docs/onboarding.md#ios-app-optional) cover the optional
Capacitor app and Xcode setup.

## Documentation

| Topic                                     | Start here                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Agent profiles and reusable context       | [Agent Library](docs/features/agent-library.md)                               |
| Reference documents                       | [Knowledge Library](docs/operations/knowledge-library.md)                     |
| Outcomes and progress                     | [Telos workflow](docs/operations/telos-artifacts.md)                          |
| Assigned agent tasks and current limits   | [Persistence and current limits](docs/features/agent-tasks.md)                |
| Account and service inventory             | [Connections](docs/features/connections.md)                                   |
| Authenticated APIs and credential storage | [Keychain connections](docs/keychain-connections.md)                          |
| Tool approvals and execution limits       | [Unified chat permissions](docs/design/unified-chat-permissions.md)           |
| Fresh-agent collaboration contracts       | [Symposium slice 2](docs/features/symposium-conversation-contracts.md)        |
| Collaboration and its current limits      | [Symposium source guide](docs/features/symposium.md)                          |
| OpenShell host configuration              | [OpenShell operations](infra/openshell/README.md)                             |
| Production releases                       | [Guarded release and deployment script](scripts/create-release.sh)            |
| Staging history (stood down)              | [Retained canonical staging procedures](docs/operations/canonical-staging.md) |
| Backups and recovery                      | [Encrypted ecosystem backups](docs/operations/icloud-ecosystem-backup.md)     |

`npm run deploy` is a guarded macOS service deployment, with release-manifest and
runtime prerequisites. It is not a fresh-clone installation command. Follow the
release and host configuration contracts before changing a running service.

## Development

The repository uses npm workspaces: a TypeScript/Express server, a React/Vite
frontend, and shared protocol, harness and client packages. Build the shared
packages before starting development servers:

```bash
npx tsc -b packages/protocol packages/harness packages/client
npm run dev          # Server and frontend with file watching
npm test             # Vitest suite
npm run lint         # Server, frontend and shared packages
npm run format:check # Prettier
npm run test:design  # Shared UI token contract
npm run test:ui      # Offline browser/layout fixtures
```

Browser tests require Playwright's browsers (`npx playwright install webkit chromium`).
See [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) for contribution, testing and
staging conventions. Changes go through branches and pull requests. Keep the
README focused on the product and entry points; document detailed behavior in
the relevant guide under `docs/`.

See [CI delivery](docs/operations/ci-delivery.md) for parallel coverage, retained
failure evidence, bounded infrastructure recovery and batching a landing candidate.

## Attribution and license

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center)
by [Afstkla](https://github.com/Afstkla).

[MIT license](LICENSE).
