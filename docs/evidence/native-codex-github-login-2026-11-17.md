# Native Codex GitHub login visibility

Observed 2026-11-17, before deployment of this change. This is investigation
evidence, not proof of production activation or a universally broken Codex route.

## Observations

- The operator's Mitzo terminal completed GitHub web login as `dimakis`.
- Claude conversation `c6d21c17-9a21-801e-b0c4-795ea2ce6fef` reported running
  `python3 -m mgmt_lib.pr_merge_gate dimakis/mitzo 1394 --merge` successfully.
  GitHub independently confirmed merge at 22:56:42 UTC, accepted commit
  `f642f875d6a5a61e2208d216795c9d96a4f5dd63`.
- Native Codex conversation `a14ebc2d-8f68-8983-9f2c-6f65d5aa5921` received HTTP
  401 from the helper's first `gh pr view` and from `gh api user`. No merge was
  attempted by those failed helper calls.
- Its native process used `/opt/homebrew/bin/gh`, ordinary host HOME, no
  GH_CONFIG_DIR/XDG_CONFIG_HOME override, and neither GH_TOKEN nor GITHUB_TOKEN.
  `gh auth status --json hosts` reported tokenSource `default` and HTTP 401.
- The operator reports earlier successful merges using Codex. We have not proved
  which session, credential-storage or runtime change triggered this incident.
  A missing environment token alone does not prove an invalid host login.

## Source trace and repair

Claude's SDK boundary already resolves the operator's host `gh` login outside
the sandbox and transfers it only to the owned child environment. Native Codex
allowed reading the host gh configuration but continued to deny Keychain access.
Its app-server environment deliberately discarded inherited credentials and had
no equivalent explicit host-login transfer. These observations explain a
credential-visibility gap; the exact historical trigger remains unverified.

The owned native bootstrap now uses the same host-login resolver for subscription,
new API and retained API launches. It never selects the controller publisher
token or an ambient API key. Only the explicit resolved credential reaches the
child process environment. Native shell configuration includes variable names,
never token values, and permits only the sanitized launch environment. Keychain
and other private-path denials remain unchanged. Preflight and legacy launches
retain their existing behavior.

The existing resolver handles unavailable host logins by returning no transfer;
the previous configuration-based gh path remains available. This change does not
refresh a running process or repair an invalid host token.

## Validation and remaining work

Two regression cases failed before the repair because the explicit host login
was absent from subscription and retained API child environments. They now pass
and check exclusion of publisher/API credentials and token-free configuration.
Six focused transport/bootstrap/resolver/policy suites pass: 179 tests. ESLint,
Prettier and reviewed source-artifact verification pass.

No model-backed test or live Keychain read was run for this change. Real native
tool execution after an accepted build and a newly launched runtime still needs
verification. Credential handling requires independent review in addition to
Centaur's exact-head gate before merge. No production activation is claimed.
