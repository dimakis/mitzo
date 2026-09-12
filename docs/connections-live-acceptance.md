# Managed Jira Connections

Accounts select inference billing. Connections grant an eligible OpenShell account access to Jira, independently of its inference provider. The first template permits authenticated reads of `https://redhat.atlassian.net` through OpenShell's enforced REST policy. Existing configured GitHub and Google Workspace providers remain operator-managed.

## Architecture and recovery

The browser reauthorizes with the Mitzo passphrase, then submits a masked token with a short-lived session-bound CSRF capability. Mitzo passes the token transiently to the trusted CLI in the child environment using the key-only `--credential JIRA_API_TOKEN` argument. The token is not saved in Mitzo's SQLite database, audit trail, browser storage, or command arguments. OpenShell owns the encrypted credential and injects its policy-bound placeholder. Jira URL and email are nonsecret, shell-quoted runtime context.

SQLite records provider identity, gateway/workspace binding, optimistic revision, account consent, probe cleanup, rotation candidates, and assignment-removal intent. Create and rotation run a disposable `/rest/api/3/myself` probe. Rotation verifies the same Jira identity before replacing the working credential. Probe and candidate cleanup use independent deadlines and survive process restart; incomplete cleanup is not reported as success. A failed authorization can be retried with a fresh token.

One control-plane queue serializes sandbox startup/reconnect with credential and consent changes. New grants require a new conversation. Existing sandboxes are checked against their actual gateway attachments before reuse. Removal stops the affected retained workloads, verifies shutdown, then detaches the provider without deleting their workspaces. Old sandboxes without an account label are conservatively stopped and detached because their ownership cannot be established. Revocation deletes the provider only after attachment cleanup and verifies its absence. It does not revoke the API token at Atlassian.

## Configuration

Use the reviewed `0.0.116-mitzo.2` CLI and the normal OpenShell gateway/account configuration. Set these server-owned values from `infra/openshell/production.env.example`:

- `MITZO_CONNECTIONS_ENABLED=1`
- `MITZO_CONNECTIONS_JIRA_PROFILE_PATH`: absolute path to `infra/openshell/providers/mitzo-jira-readonly.yaml`
- `MITZO_CONNECTIONS_PROBE_IMAGE`: reviewed runtime image containing `/usr/bin/python3`
- `MITZO_CONNECTIONS_PROBE_POLICY`: absolute path to `infra/openshell/providers/mitzo-jira-probe-policy.yaml`

The controller validates the local profile and gateway-exported policy. It imports the profile only after an authoritative profile list confirms that it is absent. Broader policies, other endpoints, credentials, and enforcement modes are rejected. The SQLite metadata lives in `.mitzo/connections.db`; preserve it with gateway backups. Reconciliation runs at startup and every 30 seconds. Disabling the control plane does not permit retained managed grants to bypass runtime attachment checks.

## Live acceptance before deployment

Automated tests exercise the CLI contract, lifecycle failures, retained permissions, HTTP defenses, and UI flows. They do not establish live Jira authorization or production gateway compatibility. Run the following against a non-production gateway before rollout:

1. Confirm `openshell --version` and lint the checked-in Jira provider profile using `openshell provider profile lint --file <absolute-profile-path>`. Start Mitzo on an isolated port with the configuration above.
2. Open More → Connections, reauthorize, and authorize a user-owned Jira token for one eligible account. Enter the token only in the browser form. Confirm identity verification and probe deletion precede active status.
3. Start new conversations for assigned and unassigned accounts. Confirm only the assigned sandbox has the managed Jira provider and that its authenticated read succeeds. Verify a Jira write request is denied by the gateway policy. A retained unassigned conversation must require a new conversation to gain access.
4. Rotate to another token for the same Jira identity. Confirm attached workloads stop, the replacement succeeds, and the candidate provider and probe disappear. An invalid token or different identity must leave the original credential unchanged.
5. Remove an assignment and revoke a connection while a conversation is retained. Confirm shutdown, detachment, provider absence, and workspace preservation. Interrupt the controller during cleanup and confirm restart reconciliation completes it.
6. Verify browser/API errors, audit records, server logs, and saved metadata contain no submitted token. If upstream revocation is desired, revoke the token separately in Atlassian.

Production deployment and live credential validation are separate from implementing this feature.
