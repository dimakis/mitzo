# Connections: account evidence and service scope

More → Connections lists AI accounts and service connections. Choose the AI
account inside a chat. Setup, authentication checks and successful use are
different observations; none of them expands a chat's service permissions.

## Add an AI API account

Connections → Add → AI API account supports OpenAI, an EnMaaS preset, and a
custom Responses-compatible API. Custom accounts use the existing Codex
app-server on Local Mac. They are excluded from the legacy Responses engine,
OpenShell routes and official-OpenAI key rotation. Existing chats retain their
frozen account and endpoint. Select the new account and model for a new chat.

After browser reauthorization, enter a public HTTPS API base URL and a key.
**Get models** reads that exact endpoint's `/models` with bearer authentication;
it makes no inference call. The request uses checked public DNS, verified TLS,
a 15-second deadline and a bounded response, and never follows redirects with
the key. Discovery errors remain visible. Changing the endpoint or key discards
its catalog; late responses cannot overwrite the new selection.

Select models from the catalog or enter explicit model IDs, one per line.
Catalogs are advisory and may be incomplete. Explicit IDs can be saved even
when `/models` is unsupported; that saves configuration without validating the
key or making a model call. Saving requires the operator's explicit confirmation
of Responses streaming, tools, follow-up turns and cancellation compatibility
for the selected models. Neither discovery nor saving establishes that evidence.
There is no protocol fallback or automatic translation of Chat Completions or
Anthropic Messages to Responses.

The EnMaaS preset uses `https://api.enmaas.devshift.net/v1` and prepopulates:

- `rits/zai-org/glm-5-3`
- `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`

These hosted IDs stay explicit when discovery omits them. Discovered models
are never automatically selected; other catalog entries can incur charges.
The saved EnMaaS Source page, inspected on 10 November 2026, lists these hosted
models and documents GLM restrictions around grammar/freeform tools, images and
compaction. This enrollment change does not verify GLM's compatibility with the
Codex engine or guarantee continuing free access. Live model qualification is a
separate check under the repository's live-test policy. Source:
[EnMaaS — The Source](https://source.redhat.com/departments/products_and_global_engineering/workload_management/enmaas),
an internal Red Hat reference; no page content or credentials are bundled here.

Keys use the existing private Keychain enrollment store. Custom accounts create
no OpenShell provider replica. The journal retains operation identity, endpoint,
model selection and failure stage, with no key or key digest. Interrupted or
uncertain saves require status review and are never automatically replayed.
Invalid endpoint details remain editable before any key is sent. If the server
explicitly rejects a request before enrollment starts, correct its details and
re-enter the key to make a fresh attempt. A missing or uncertain save receipt
still requires status review.
The 2048-character endpoint limit applies to both entered and normalized URLs.
Localhost aliases with a trailing DNS root dot are rejected as well.
**Ready** here means configuration and credential custody were saved; account
authentication and successful use remain separate evidence below.

Anthropic-compatible endpoints are a follow-on using the existing Claude Agent
SDK engine. Its Google Vertex transport and Google authentication must be
disabled for a direct EnMaaS Messages connection; EnMaaS does not become a
Google Vertex account. That path is not enabled by this change.

## Account status

- **Set up** means a configured account or personal-connection record exists.
- **Signed in** means a recent host or isolated native account check succeeded.
- **Connection valid** means an OpenShell subscription provider/grant check
  succeeded. It does not establish an observed email, plan or model access.
- **Last sign-in check passed** describes older host or native authentication
  evidence. **Last connection check passed** describes an older provider-grant
  check. The timestamp is in the account details; an old check does not mean the
  account is signed out.
- **Connection check expired** refers to the checked grant's reported deadline.
  Refresh to check the connection again; the page does not perform sign-in.
- **Couldn't check sign-in** or **Couldn't check connection** covers an unsuccessful
  check, including timeout or cancellation, using the label for its evidence source.
  It does not assert an authentication rejection.
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
For Jira, the configured account email is displayed explicitly as configuration.
Provider account IDs of any format remain in technical details; an absent email
leaves the displayed account unchecked.

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
warning alongside an existing configured Google provider. Its management row can
replace a provider listing only when the policy-checked provider ID and workspace
match that listing; a provider replaced between reads stays separate.

Unused inventory integrations produce no warning cards. A configured source
that fails to load still offers retry, preserving older account evidence where
available. **How web access works** explains provider search, page reads and
sandbox network policies; it is not a connection health report.

These changes do not alter account routing, credential refresh, authentication
freshness rules or execution authorization. Live provider tests and deployment
remain separate actions under the [canonical staging procedure](../operations/canonical-staging.md).
