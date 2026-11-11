# Personal Claude on Local Mac

Personal Claude subscriptions use the existing Claude Agent SDK runtime, beside
the existing Vertex account. Select the account in Chat settings and run it on
Local Mac. Each conversation retains its selected account and native Claude
history. Start a new conversation to change between work and personal billing.
OpenShell and Symposium subscription execution are outside this feature.
Scoped advisers also remain unavailable for personal Claude: adviser pickers omit
these accounts and retained or forged selections refuse before allocation.

## Connect from Mitzo

In **Connections → Add connection → Claude**, choose **Sign in with Claude**.
Open the Anthropic sign-in link on the phone or computer, sign in to the intended
personal account, and paste the complete returned code into Mitzo's private
**Sign-in code** field. Mitzo submits it to the waiting official Claude Code
process. Claude Code exchanges and stores credentials and handles refresh.
The code never enters chat, request URLs, logs, browser storage or the account journal.

Mitzo creates an isolated physical account directory, verifies the native account's
email and Pro/Max plan, saves account metadata, and invalidates the account picker.
**Start chat** prepares an unsent Local Mac draft with the connected account and
current routing identity. It does not send a prompt or change saved chat defaults.
The account picker also links to the same Connections destination.

Refreshing or navigating back recovers the original pending operation. After a lost
response, **Check sign-in status** observes it without submitting the code again.
Cancellation, expiry and logout stop native work; a small supervisor also terminates
the native login if the controlling process disappears. A restarted host retains
an interrupted receipt rather than claiming that the login completed. Unconfirmed
cleanup or journal writes stay visible with a diagnostic reference and block another login.

Managed metadata lives in `$HOME/.claude-mitzo-accounts/accounts.db`, with native
login/history in a separate directory per account under that root. The optional
operator setting `MITZO_CLAUDE_ACCOUNTS_DIR` relocates the whole private root.
It must be a physical, user-owned 0700 directory outside `.mitzo` and other outer
runtime/profile roots. Pending and completed storage is denied to agent file tools.
No configuration changes are required for the default location. Existing operator
profiles are read and combined with managed accounts, without rewriting their file.
Existing manual Claude profiles remain supported through their original setup below.
There is no fixed account-count or login-history quota. Each addition gets its own
account identity and native directory; reconnect explicitly selects an existing
account. Login setup is serialized to one pending operation, independently of the
number of saved accounts. Catalog responses retain the existing 1 MiB byte budget;
the earlier 64-account/128-route count limits are removed. A larger transport would
require pagination rather than silently dropping accounts or weakening that budget.

## Models and thinking

Switching accounts in an unsent chat restores that account's model and thinking
choices on this browser. With no saved account choice, its configured first model
and supported default thinking level seed the picker. Explicit new-chat defaults
remain a separate action. Bound conversations retain their original account;
loading or refreshing metadata never rewrites retained conversation intent.

Selecting personal Claude reads its native SDK model metadata under that account's
isolated sign-in. **Refresh models** bypasses the selected account's metadata cache.
Versioned names (for example, Claude Opus 4.8) come from the native model's
label, leading description or exact versioned model ID; aliases are never mapped
to an assumed release. Context-window variants retain their label qualifiers.
Only the native model's supported thinking levels are offered. Changing models
retains a supported thinking choice and otherwise uses the new model's default.
Discovery initializes a tool-free SDK control connection, without a user prompt,
project settings, hooks, MCP servers or persisted conversation. Account identity
and custody are checked before publishing the catalog; ordinary send admission
still checks current authority. Failed discovery retains the last catalog (or the
configured aliases before the first success) with a visible retry notice.

## Three distinct Claude account routes

Dimitri's explicit requirement on 10 November 2026 is to preserve **Vertex,
the forthcoming enMaaS Anthropic-key account, and personal Claude subscriptions**
as independently selectable accounts. A shared model/provider brand never chooses
billing or credentials. A conversation retains its selected account and route.

| Account              | Authentication and route                                    | Onboarding change                                                     |
| -------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Work Vertex          | Existing Google ADC/project/region and Claude SDK           | Existing configuration and conversations retained                     |
| enMaaS Anthropic key | Its own key, endpoint and account binding                   | Forthcoming integration; this change does not implement or qualify it |
| Personal Claude      | Official Claude Code subscription login in isolated storage | Managed phone/browser onboarding                                      |

Personal login launches with a clean environment. Subscription SDK environments
discard API keys, custom Anthropic endpoints and Vertex settings. Returning to
Vertex restores that account's configured project and ADC without inheriting the
personal configuration directory. Regression tests include synthetic enMaaS key
coordinates to verify this separation. Adding enMaaS must extend the account
catalog and its native adapter, rather than changing a global Claude login or
replacing Vertex/subscription routing. Do not send its key to subscription login.

## Advanced: sign in once on the Mac

Use the unmodified Claude Code executable installed with Mitzo's Agent SDK.
On Apple silicon it is
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`; Intel Macs use
the corresponding `darwin-x64` package. Sign-in and refresh remain owned by Claude
Code. In this manual setup, codes go directly to the CLI. The managed private form
above relays one authorization code to that same native command; Mitzo does not
exchange or copy OAuth tokens.

Give the account a dedicated physical directory, owned by the Mac user with mode
0700, for example `$HOME/.claude-mitzo-personal`. Keep it outside `.mitzo` and the
private runtime/profile configuration directories: those are deliberately blocked
by the outer SDK process sandbox. Use this same directory for login and the profile.

From the Mitzo installation, with `CLAUDE_BIN` set to that executable's absolute
path:

```sh
mkdir -p "$HOME/.claude-mitzo-personal"
chmod 700 "$HOME/.claude-mitzo-personal"
env -i HOME="$HOME" PATH="$PATH" \
  CLAUDE_CONFIG_DIR="$HOME/.claude-mitzo-personal" \
  "$CLAUDE_BIN" auth login
```

Choose the personal Claude account in Anthropic's flow. The clean environment
prevents work Vertex settings or API keys from selecting a different billing route.
Use `auth status --json` with that same environment to check sign-in, or `auth logout`
to sign out. Never paste tokens into profile JSON or chat.

## Advanced: add the account to existing profiles

Add an entry to the operator's existing `MITZO_ACCOUNT_PROFILES_FILE`. Retain the
existing Vertex entry. Replace the example email and absolute directory with the
signed-in account's values. `planType` supports `pro` and `max`; it must match the
native CLI's observed subscription type. Model entries are configured availability,
not proof of subscription access; choose models available to the actual account.

```json
{
  "id": "claude-personal",
  "label": "Personal Claude",
  "provider": "anthropic-claude",
  "credentialRef": "/absolute/path/to/.claude-mitzo-personal",
  "email": "you@example.com",
  "planType": "max",
  "models": [
    {
      "id": "claude-opus-4-8",
      "label": "Claude Opus",
      "reasoningEfforts": ["low", "medium", "high", "max"]
    }
  ]
}
```

The current Local Mac Claude target and
`MITZO_ORDINARY_LOCAL_VERTEX_ENABLED=1` also serve personal Claude. No second
runtime, target registration, command queue or Responses engine is introduced.
Reload the account catalog, check sign-in in Connections, and select Personal
Claude in a new Local Mac chat. Existing Vertex conversations keep their identity.

## Retained identity and recovery

Admission verifies the native CLI's subscription sign-in against the configured
email and plan. The running SDK also reports its account before each prompt is
released. Vertex, API-key, proxy and environment OAuth-token overrides are removed.
Logout, account/plan mismatch, replaced login directories, changed profiles or a
changed selected CLI binary block execution instead of falling back to another
account. Native token refresh for the same account is allowed.

The trusted Claude process can write its own login and history. Agent-requested
file tools cannot read private account roots or aliases; Bash requires the SDK
sandbox with private roots denied and no unsandboxed escape. The existing outer
SDK boundary and shared permissions remain in place. Public account metadata
contains billing and sign-in evidence, never the credential directory or tokens.

File searches use sandboxed Bash. Native Grep and Glob are refused for personal
accounts because recursive searches and absolute patterns can otherwise traverse
private account storage outside the Bash sandbox. Sign-in failures retain their
original cause internally and report a sanitized diagnostic reference; cancellation
remains distinct from a failed account check.

Cold continuation and history reads use the original account configuration.
Approved web searches bind the same retained executable and withhold their query
until their own initialized SDK child confirms the selected subscription identity.
The SDK's filesystem history readers run in a separate process for personal
accounts, so concurrent work/personal sessions never mutate the controller's
global `CLAUDE_CONFIG_DIR`. Transcript parsing remains SDK-owned.

## Verification status

### Model controls, 11 November 2026

The account picker, account preferences and native metadata tests reuse existing
fixtures. Native metadata tests mock only the SDK process/custody boundary, exercise
the real catalog validation/projection, and submit no model prompt. Existing HTTP
entry tests cover selected-account refresh and login revocation before delivery.
The focused regression/design run passed 275 tests (one existing skip) in 10.87s;
the HTTP entry file passed 66 tests in 3.57s outside the socket-restricted sandbox.
Later focused additions are recorded in the PR validation. No full-suite runtime
or CI cost delta has been measured locally.

The existing intercepted `chat-model-settings` journey now switches between
OpenAI and Claude, refreshes choices, selects thinking, switches back, and verifies
retained settings and composer text. It adds no backend or full-app journey. All
six theme/browser variants plus two browser-startup checks passed in 11.8s, one
worker with a 2 GiB command-local Node heap. Inspected [mobile dark](../design/assets/account-model-settings-mobile-dark.png)
and [desktop light](../design/assets/account-model-settings-desktop-light.png)
captures preserve the approved settings sheet, Mint/System and Teal/Georgia.
Full builds and the broader browser matrix remain CI gates. No live subscription,
model call, staging operation or deployment was performed.

Onboarding implementation and offline verification were added on 10 November 2026
following Dimitri's request in the originating implementation conversation. The
installed Claude Code 2.1.141 and Agent SDK 0.2.141 were inspected; an isolated
native probe confirmed a hosted manual redirect URL, PKCE and stdin code validation.
The probe disabled browser opening and submitted only invalid synthetic input.
[Anthropic's authentication guide](https://code.claude.com/docs/en/authentication#log-in-to-claude-code)
documents the manual-code fallback; retrieved on 10 November 2026. The SDK also
contains private authentication methods absent from its public type interface, so
this implementation uses the documented CLI instead.

Tests exercise fake native executables, real subprocess supervision, authenticated
HTTP failure delivery, durable metadata, revocation, recovery and the private form.
The all-intercept browser fixture covers phone/desktop, light/dark themes,
Mint/System and Teal/Georgia, keyboard input, narrow bounds and lost acknowledgements.
Full frontend/server type checking and the production bundle passed locally with
a 3 GiB build heap; focused tests use one worker and a 1 GiB heap. The consolidated
regression/design run passed 300 tests (one pre-existing skip); the later logout
race regression also passed. Browser discovery lists all six fixture variants,
but local startup was blocked by macOS process-registration permissions even
through the approved execution route. No sandbox bypass was used. Browser
rendering/visual inspection and an actual phone-to-Mac account login remain to be
verified. No live account, paid inference, production configuration,
deployment or model call was used. Review this evidence when the CLI/auth contract changes.

### Initial runtime work

Implementation and offline fixtures were prepared on 6 November 2026 against
Mitzo main `f9b0f3a1e4f14c68d5a9c5d3955a1b1e12f7c178`, following Dimitri's explicit
Local Mac implementation request. Tests simulate subscription status and SDK
model output; the account-history test uses real SDK filesystem readers with
synthetic transcripts. No personal subscription, paid inference, production
configuration or deployment was used. Actual subscription acceptance, installed
CLI/auth compatibility and product-use authorization remain live qualification
items before activation. Review this record when the SDK or Anthropic sign-in
contract changes. See [Anthropic authentication](https://code.claude.com/docs/en/authentication)
and [credential-use guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
