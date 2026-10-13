# Jira reads in API chats

OpenAI API chats use Mitzo's host connection tools. Their Bash commands have no
network or credentials, so the shared OpenShell `./mgmt jira` route cannot fetch
live Jira there, even with Python `requests` installed.

Call `ListConnections` and reuse an existing Jira connection with transport
`keychain-https`. Request access for this chat, then use `ConnectionRequest` GETs
under its configured API prefix. A saved OpenShell connection is a separate
transport; its enrollment does not grant host API access or export its token.

If no suitable connection exists, `PrepareConnectionSetup` supports a fixed
read-only Jira Cloud profile. It requires only public site/account information:

```json
{
  "profile": "jira",
  "endpoint": "https://api.atlassian.com",
  "access": "read",
  "jira": {
    "email": "reader@example.com",
    "cloudId": "00000000-0000-4000-8000-000000000000"
  }
}
```

For an ordinary tenant token, use `https://your-site.atlassian.net` and omit
`cloudId`. Scoped tokens use `api.atlassian.com` and the known cloud ID, as
documented by [Atlassian](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).
Do not guess the cloud ID or retrieve credentials from workspace/editor files.

The secure setup card accepts the token directly from the user. The host verifies
an authenticated `/myself` response containing an `accountId`, stores the token
in Keychain, and exposes only non-secret metadata. A public/anonymous success or
HTML login response does not verify the credential. Setup grants no chat access;
each chat must approve the connection separately. Keychain controller enrollment
must already be configured; this profile does not configure the host controller.

The fixed scope permits GET and HEAD only under `/rest/api/3/`, prefixed with
`/ex/jira/<cloudId>` for scoped tokens. Writes, private-network overrides and
arbitrary destinations are rejected. Use `search/jql` with URL-encoded parameters
and follow `nextPageToken` until `isLast`. Read issues and recent comments only
as needed; preserve the user's existing scope and Jira field conventions.

Offline regressions cover secure enrollment, both URL forms, rejected scope
overrides, separate session grants, native API dispatch in Agent/Ask modes and
disabled-connection refusal. They use fake vaults and network responses; no
Jira credentials or models are charged. Live provider verification requires
independently reviewed canonical staging enrollment. Production activation
requires a separate explicit user action.
