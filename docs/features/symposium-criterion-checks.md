# Symposium criterion checks

The production review host accepts an optional `criterionChecks` array in its private
`MITZO_SYMPOSIUM_OWNED_HOST_CONFIG` JSON. Each entry maps one exact acceptance
criterion to one code-supported check:

```json
{
  "criterionChecks": [
    {
      "id": "approved-marker",
      "criterion": "The approved marker exists",
      "version": 1,
      "kind": "file-sha256",
      "path": "marker.txt",
      "expectedSha256": "<64 lowercase hex characters>"
    }
  ]
}
```

The full host config remains private and owner-controlled. `path` is relative to
the committed artifact root; no command or script is supplied in a request. The
physical check launches the pinned credential-free Git verifier in a read-only,
network-disabled helper, and compares the committed file SHA-256 with the
configured expected value. Missing files produce a failed check.

Create an application run using `POST /api/sessions/:id/symposium/reviews/application-runs`
with `acceptanceCriteria` containing the exact configured `criterion` text and
the normal initial artifact revision/hash and application limits. After the
final artifact and independent review are current, run the check through
`POST /api/sessions/:id/symposium/reviews/:workflowId/actions`:

```json
{
  "action": "check",
  "definitionId": "approved-marker",
  "expectedArtifactRevision": "<current commit>",
  "expectedArtifactHash": "<current committed tree digest>"
}
```

The response is the updated workflow after the exact host evidence is recorded.
The route uses the existing interactive authentication and current revision
fence. The check receipt binds the current result ID, commit, tree digest,
artifact generation, completed physical seal, definition digest, physical
execution ID and observed file digest. A stale result, altered receipt, unknown
definition or unmatched criterion cannot be verified. Free-form acceptance
criteria have no automatic check and keep finalization at `missing_evidence`.

For a credential-free physical contract check on the pinned workload image, run
`node --import tsx server/__tests__/symposium-criterion-physical-fixture.ts` on a
host with Podman. It creates and removes its own disposable volume. This proves
the bounded Git helper; it does not substitute for a full authenticated
source-to-review application run.
