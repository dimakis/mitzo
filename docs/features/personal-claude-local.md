# Personal Claude on Local Mac

Personal Claude subscriptions use the existing Claude Agent SDK runtime, beside
the existing Vertex account. Select the account in Chat settings and run it on
Local Mac. Each conversation retains its selected account and native Claude
history. Start a new conversation to change between work and personal billing.
OpenShell and Symposium subscription execution are outside this feature.
Scoped advisers also remain unavailable for personal Claude: adviser pickers omit
these accounts and retained or forged selections refuse before allocation.

## Sign in once on the Mac

Use the unmodified Claude Code executable installed with Mitzo's Agent SDK.
On Apple silicon it is
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`; Intel Macs use
the corresponding `darwin-x64` package. Sign-in and refresh remain owned by Claude
Code. Mitzo does not receive browser authorization codes or copy OAuth tokens.

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

## Add the account to existing profiles

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
