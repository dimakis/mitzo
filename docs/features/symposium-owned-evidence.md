# Owned Symposium admission evidence candidate

A fresh isolated app host can collect a candidate through
`POST /api/symposium/admission-evidence`. This endpoint requires the same
interactive operator authentication as personal login; an internal runtime token
is insufficient. It operates on the host already installed inside that app
process, never adopting another gateway or accepting caller custody assertions.

For an app-owned Personal connection and an app-created draft, prefer the
operator-only slot selection form:

```json
{
  "personalConnection": { "connectionId": "EXACT_CONNECTED_SLOT", "expectedRevision": 3 },
  "sessionId": "EXACT_DRAFT_SESSION",
  "allowedRoles": ["coder", "reviewer"]
}
```

The retained host resolves the provider name and ID from that slot's live adapter
receipt; disk display metadata and CLI name guesses cannot substitute for it. The
slot must be connected at the explicit revision, with no pending model discovery
or reconciliation. The host derives the ready artifact volume from the same
session's owned ledger and verifies physical session/generation labels. Callers
cannot supply a provider or volume override with this form. It permits only the
`openai-codex` account provider. Requested roles remain explicit.

The session must still be a Symposium draft; a retained volume ledger row alone
cannot authorize evidence after deactivation. Draft state is checked around each
physical read, before and after the worker returns.

Slot revision/state, retained receipt identity, and gateway custody are checked
before collection and again after asynchronous evidence collection and physical
volume reads. The ready session-volume mapping must still match. A disconnect,
replacement, discovery transition, or contradictory volume invalidates the request
instead of returning a stale candidate. No credentials or account email are added
to the response; provider identities are the same public metadata already present
in the candidate format. This is evidence collection only: it never installs the
attestation, activates a seat, starts inference, or bypasses existing admission.

The original explicit provider/volume form below remains supported and is still
strictly validated by the unchanged physical verifier. The two forms cannot be
mixed. Neither automatically widens the allowlist.

After explicitly provisioning the intended providers and baseline artifact volume,
send the exact selection using the app's authenticated HTTP client:

```json
{
  "providerInstances": [
    {
      "name": "EXACT_PROVIDER_NAME",
      "id": "EXACT_PROVIDER_ID",
      "type": "codex",
      "profileName": "codex"
    }
  ],
  "allowedRoles": ["implementer", "reviewer"],
  "allowedAccountProviders": ["openai-codex"],
  "artifactVolume": { "driver": "podman", "name": "EXACT_VOLUME_NAME" }
}
```

These placeholders must be replaced with observed identities from this fresh
owned gateway and its actual prepared volume. Nothing picks a default account,
widens the provider allowlist, or manufactures missing physical evidence. The
baseline volume must already satisfy the existing gate's ownership labels.

The retained host measures its configured policy, complete seed tree, and public
profile exports. Reviewed native build constants supply the expected image and
binary hashes. The unchanged full production verifier checks the actual CLI,
owned gateway custody, native artifacts, exact live provider instances, and
physical volume. Its existing image inspection uses temporary stopped containers;
no model request or sandbox workload is executed. Custody is checked again before
returning. A mismatch returns HTTP 409 without a candidate; malformed selections
return 400 and a missing host returns 503. Private diagnostic output is not returned.

A successful response contains `candidate` and `activated: false`. It does not
write the configured attestation file, alter admission, create a session, or start
a seat. Review the candidate and its physical provenance before a separately
reviewed installation step. Existing admission still reads the private host file
and rechecks the same gate. This change does not provide automatic installation or
claim full app acceptance. A service restart requires fresh custody and evidence;
a candidate from an older gateway must not be reused.

Validation uses mocked public CLI/physical proofs and the real admission verifier,
including a contradictory-volume rejection. No live OAuth or model calls were
made for this helper. The earlier reviewed native-image live proof remains a
separate, limited prerequisite: see [reviewed native build](symposium-reviewed-native-build.md).

## Probe scheduling and cleanup

Candidate collection runs in a dedicated worker so synchronous public CLI and
Podman probes do not occupy the HTTP event loop. Custody requests return to the
actual retained app host: it checks its live child, immutable launch binding,
private file bytes and listener PID. This endpoint uses asynchronous file hashing
and a bounded asynchronous listener probe. No gateway object is adopted by the
worker, and no custody result is supplied by the HTTP caller.

Only one collection can run per host. A concurrent request fails rather than
queuing more probes. Client disconnect does not terminate the worker halfway
through stopped-container cleanup. A response waits for worker exit and a final
retained-host custody check. Abnormal worker exit or failed physical cleanup
quarantines further collection until operator recovery; it never claims that
cleanup succeeded. Temporary containers are named by the existing physical
verifier and remain never-started, with exact-name removal attempted even when a
create response is lost.

The existing synchronous production runtime admission gate remains synchronous
and otherwise unchanged; this scheduling applies only to candidate collection.
Offline validation covers real worker startup under TSX source and separately
compiled JavaScript, slow synthetic CLI responsiveness, concurrent requests,
client disconnect, stopped custody, and failed cleanup. No live model or OAuth
calls are involved.
