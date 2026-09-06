# Account profiles: first mobile slice

The mobile chat page loads account and model choices from `GET /api/accounts`. A new task sends an account ID and model; the server validates them before starting the existing SDK harness. The selected binding is stored with session metadata when the SDK resolves its session ID. Reloading the conversation displays that saved binding. Follow-up input and resumed tasks retain the binding.

This slice implements **Claude on Vertex AI only**. OpenAI API and ChatGPT subscription execution are not yet implemented. Existing clients and legacy conversations retain their previous routing behavior. The desktop chat picker remains unchanged.

## Configuration

Set `MITZO_ACCOUNT_PROFILES_FILE` on the Mac to an absolute path containing a JSON array:

```json
[
  {
    "id": "work",
    "label": "Work Vertex",
    "provider": "anthropic-vertex",
    "projectId": "your-google-cloud-project",
    "region": "us-east5",
    "credentialRef": "/absolute/path/to/application_default_credentials.json",
    "models": [{ "id": "claude-sonnet-4-6", "label": "Sonnet 4.6" }]
  }
]
```

Credential references point to server-side Google application-default credential files. Do not put credential values in the profile file. Google authentication owns token refresh; Mitzo does not copy access tokens to the phone. The catalog returns account IDs, labels, provider, billing category, configured models, and harness capabilities, omitting credential paths and project configuration.

When no profile file is configured, an existing `ANTHROPIC_VERTEX_PROJECT_ID` produces a `vertex-default` profile using `CLOUD_ML_REGION` and `GOOGLE_APPLICATION_CREDENTIALS` (or the conventional local gcloud ADC path). Its model allowlist preserves the existing model catalog. This list is configuration, not live discovery or proof that every model is enabled for the project. Configure a narrower list for account-specific availability. Authentication and model access failures remain explicit SDK errors.

The server rejects unknown accounts, unlisted models, malformed profiles, duplicate account IDs, inline secrets, and unimplemented provider types. Selected Vertex sessions remove alternate provider credentials and routing variables from the SDK environment, then explicitly set the project, region, and ADC path.

## Persistence and compatibility

A nullable `account_binding` column is added to the event store. Bound tasks store account ID, display label, provider, model, and a digest of the routing configuration. Updating a profile's project, region, provider, or credential reference invalidates resume instead of silently changing billing identity. A changed model allowlist is also enforced on resume. Updating a label does not rewrite historical labels.

Changing accounts or models inside a bound task is deferred. Legacy sessions cannot be converted to explicit account profiles by a follow-up request. Old clients that do not send an account ID continue to work. The existing session ID, tool loop, native execution, permission handler, context loading, queue, cancellation, chat transport, and terminal transport are retained.

The digest pins a credential reference, not the identity inside a credential file. Replacing the credential file's contents is an operator action that requires care. Binding persistence currently occurs at the first assistant event; failures before the SDK produces a session ID still have the legacy startup-persistence limitation.

## Following slices

1. Repair the independently reproduced baseline test failures and land this slice through normal review.
2. Add OpenAI API execution through the existing `ModelSession.turn()` boundary, preserving a native execution/permission boundary and durable session ownership. Inventory SDK tools, MCP, context, approvals, queueing, cancellation, and resume before replacing their behavior. `ModelProvider.call()` remains the lightweight reasoning completion interface; do not add another competing invocation abstraction.
3. Implement and verify the required tool loop and lifecycle behavior, then advertise OpenAI API profiles in the same account catalog.
4. Independently assess ChatGPT subscription execution. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) provides managed ChatGPT login, account inspection, model discovery, thread/turn operations, approvals, and streaming. Use `model/list` and provider capabilities instead of assuming all ChatGPT models are available. API billing and ChatGPT login are separate paths. No Pro integration is claimed here.
5. Prove physical-phone behavior, approval/cancellation parity, long disconnects, retry deduplication, and restart recovery on every advertised route before declaring the first release complete.

Transport PRs #430/#440/#445 and Symposium #446 remain deferred for this slice: no transport replacement is needed to add profiles. Model PR #443 remains conflicting and its fallback design is not adopted. Provider PRs #437/#448 are already merged into the baseline.
