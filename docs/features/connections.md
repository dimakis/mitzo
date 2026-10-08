# Connections: account evidence and service scope

More → Connections lists AI accounts and service connections. Choose the AI
account inside a chat. Setup, authentication checks and successful use are
different observations; none of them expands a chat's service permissions.

## Account status

- **Set up** means a configured account or personal-connection record exists.
- **Signed in** means a recent host or isolated native account check succeeded.
- **Connection valid** means an OpenShell subscription provider/grant check
  succeeded. It does not establish an observed email, plan or model access.
- **Last sign-in check passed** describes older evidence. The timestamp is in
  the account details; an old check does not mean the account is signed out.
- **Connection check expired** refers to the checked grant's reported deadline.
  Refresh to check the connection again; the page does not perform sign-in.
- **Couldn't check sign-in** covers an unsuccessful check, including timeout or
  cancellation. It does not assert an authentication rejection.
- **Reconnect required** is used for an explicit personal reauthorization state,
  Google sign-in requirement or recognized managed-service authentication rejection.

An API account without authentication evidence says **Credentials not checked**.
When successful-use history exists, the list instead shows **Last used
successfully** with its timestamp. This is historical evidence, not a current
login or permissions guarantee. Account details keep configuration, sign-in and
access evidence separate. Reserved `.invalid` placeholder email addresses are
not displayed as account identities.

Successful ordinary-chat results record completed account use against the exact
account ID, provider and routing revision in `.mitzo/account-use.db`.
Failed results, interrupted requests and subagent models do not establish this
evidence. Model IDs are recorded only from primary Claude SDK provider events;
synthetic rendering and native-adapter model selections are not observations.
Other runtimes retain completed account-use history with **Model not recorded**
in the details, rather than an invented provider model. Only models still in the current account catalog are shown. Changing
the account's routing revision prevents old evidence from being attributed to
the replacement route. The store retains at most 1,000 account-route/model
records, contains no prompts, credentials or emails, and survives restart.
History starts when this implementation is activated; older conversations and
Symposium seats are not backfilled. An unavailable history store does not hide
the account catalog. Opening or refreshing Connections makes no inference calls.

## Services

**Connection enabled** describes the configured service's active state. Its last
successful credential-check timestamp is historical; it does not become an
error after five minutes. Scope and configured permissions are shown separately.
For Jira, a configured account email can be displayed explicitly as configuration
instead of showing the opaque provider account ID. The ID remains in technical
details.

GitHub's **PR repositories** and **PR base branches** restrict publication; they
do not describe all read access. **PR publishing after approval** is displayed
only when a current active grant includes an assigned account and the publishing
executor is enabled. Each publication retains its existing approval flow.

The inventory reconciles a managed connection and provider listing only within
the same gateway/workspace and a unique matching provider reference. The live
provider ID and observed workspace must be present and match the managed record. Service labels alone never
merge records. A distinct or uncertain GitHub provider is labelled **additional
connection**; unknown identities and permissions remain explicitly unchecked.
Google Workspace's unused management integration does not create an extra row or
warning alongside an existing configured Google provider.

Unused inventory integrations produce no warning cards. A configured source
that fails to load still offers retry, preserving older account evidence where
available. **How web access works** explains provider search, page reads and
sandbox network policies; it is not a connection health report.

These changes do not alter account routing, credential refresh, authentication
freshness rules or execution authorization. Live provider tests and deployment
remain separate actions under the [canonical staging procedure](../operations/canonical-staging.md).
