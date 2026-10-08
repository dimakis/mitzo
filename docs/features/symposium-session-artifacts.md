# On-demand Symposium session artifacts

New Symposium draft creation now calls the installed owned host's artifact preparation
capability after durable session allocation. The same idempotency key retries that
session, including when the original account is temporarily unavailable. An
operator-only `POST /api/symposium/sessions/:sessionId/artifacts` retries preparation
for an existing Symposium; it accepts no volume, path, driver, labels or grants.
Preparation failure retains the draft. The creation panel offers **Retry shared
files** and **Open draft**. Reopened saved drafts expose **Prepare or retry shared files** in Director controls, so recovery survives navigation or a page reload. This preparation action never activates the roster or dispatches a prompt. An absent owned host reports pending preparation.

The owned host stores a lifecycle ledger inside its stable private gateway state parent directory.
Each session receives a generated volume name and generation before a create command
can run. Public Podman `volume ls`, `volume create --driver local --label …`, and
`volume inspect` commands use the configured owned executable and environment, with
custody checked before and after every command. Exact workspace, session, generation,
attachability and purpose labels, local driver and empty options are required.
Concurrent instances cannot issue a second create for the same reservation. A
pre-existing volume collision is quarantined. An uncertain create retains the
original identity and can only become ready after matching physical inspection;
a retry never issues another create. No delete or lease-release capability is added.

Ready mappings feed the existing `artifactRequest` path. Current seat membership,
generation and host authority still determine writer versus reviewer access. The
existing exclusive writer lease, read-only reviewer configuration and physical mount
checks remain required before runtime admission. Static bootstrap mappings continue
to work. Preparation accepts saved v2 drafts as well as active sessions, and does
not itself activate either.

The immutable production attestation's artifact volume remains its baseline host
physical proof; this change neither replaces that file nor manufactures an
attestation for a new session. Each actual session volume is independently checked
by the existing lease and physical mount path. Therefore a newly created session
can obtain its mapping without restarting an already admitted host, subject to all
existing account, provider, policy and native runtime gates. A newly provisioned
provider absent from the static attestation remains a separate admission problem.

Validation is mocked: lifecycle concurrency, reopening under the same custody,
rejection of different custody, uncertain completion, collision quarantine, exact
public command construction, unchanged attestation, durable route retry and the
pending-draft UI. No live gateway, OAuth or model run was performed. The stable state parent and lifecycle ledger must be retained across launches. A fresh
gateway uses a fresh launch directory, but reads the same reservations: old-custody
sessions fail with an explicit custody error instead of receiving a new empty volume.
Restart does not silently adopt old mappings or rebind active seats. Explicit
cross-gateway recovery remains unimplemented; the original volume is retained.
Transient inspection errors preserve an already-ready mapping for cleanup; fresh
runtime admission still performs its existing physical verification. Contradictory
physical evidence invalidates readiness for new admission. Existing seat shutdown
uses a cleanup-only retained identity, still requiring the exact sandbox deletion
and lease-release proofs; it does not require the volume to remain admissible. Native
review terminal receipts, persisted application-policy integration and attended
runtime acceptance remain separate gates. Guaranteed native token/spend caps and
mandatory final usage totals are deferred under the
[current acceptance contract](symposium-integrated-acceptance.md#application-policy-contract).
