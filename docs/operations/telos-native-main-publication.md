# Native Telos main publication

`RequestGithubMainPublication` runs inside the original owned local Codex chat.
The published agent profile must explicitly select `mitzo:RequestGithubMainPublication`
version 1, and the chat must retain a current Telos lead or worker role. Legacy tool
selection, a branch export, read grant or sealed publication does not enable it.

The server reads `MITZO_TELOS_MAIN_PUBLICATION_CONFIG_FILE` at startup. This is an
absolute path to a regular, current-user-owned JSON file which is not group or
world writable and is at most 1 MiB. A final symlink is refused. Its schema is:

```json
{
  "version": 1,
  "registrations": [
    {
      "accountId": "the-selected-model-account-id",
      "connectionId": "main-publication",
      "capabilityId": "separate-main-merge",
      "label": "Reviewed main publication",
      "credentialRef": {
        "provider": "keychain",
        "service": "configured-github-service",
        "account": "configured-github-account"
      },
      "repository": "owner/repository",
      "repositoryId": 123,
      "repositoryNodeId": "R_actual_immutable_repository_id",
      "publisherLogin": "configured-publisher",
      "trustedReviewer": "configured-centaur-publisher",
      "centaurAppId": 5169606,
      "requiredChecks": ["CI", "Centaur final LGTM"]
    }
  ]
}
```

Use the repository's actual immutable IDs, trusted App and complete required
checks. Configuration holds lookup coordinates, never a token. Each account must
match exactly one registration; missing or ambiguous configuration is unavailable.
The model's tool intent cannot choose an account, credential or repository.
Startup does not read credentials, create a canonical database or run GitHub.
Missing configuration leaves this tool unavailable. Invalid configuration fails
startup rather than selecting another credential. Configuration replacement retires
the original registration; existing calls cannot inherit a successor grant.

Each native invocation retains its actual signed operator, original runtime,
account, role, workspace and pending callback claim. The existing canonical Telos
database and once-only permission owner record the operation and approval. Normal
strict GitHub CI/review protections remain mandatory. Retry after uncertainty
observes the original operation; it does not repeat the merge. A known remote ACK
is retained through later cancellation. Shutdown retires the registration.

This source path is independent of fresh Symposium preparation/counting. Source
acceptance does not install a modified native runtime, activate configuration or
authorize deployment. Qualification uses offline external boundaries and CI.

The same original host also registers explicitly selected `TelosCreateOutcome`,
`TelosAdoptSource`, `TelosSaveArtifact` and `TelosReadArtifact` tools. These do not
require GitHub configuration. Create/Adopt use the existing source review card and
retain its canonical creation/source receipt. A native prepared source approval
requires its original live callback; completed receipts remain recoverable.
Historical non-native approvals keep their original durable recovery behavior.

Artifact reads require an explicit revision pinned by the current role or the
same conversation's completed source approval for the current signed operator.
The read uses the original source owner and stored hash. There is no native Find
or latest-revision fallback. Saves retain the original request identity, own the
actual database commit and renew file identity/bytes and current native authority
at the commit boundary. Exact retry recovers the original save receipt before
re-reading a changed or deleted input file.
