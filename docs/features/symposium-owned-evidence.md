# Owned Symposium admission evidence candidate

A fresh isolated app host can collect a candidate through
`POST /api/symposium/admission-evidence`. This endpoint requires the same
interactive operator authentication as personal login; an internal runtime token
is insufficient. It operates on the host already installed inside that app
process, never adopting another gateway or accepting caller custody assertions.

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
