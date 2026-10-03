# Seat mount failure diagnostics

Seat admission verifies physical mount evidence before provider acceptance. A failed check continues to block admission. The reconciliation diagnostic exposes a fixed stage code; original command errors and parsed host details remain internal causes.

| Failure code                       | Failed check                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `SEAT_MOUNT_CONFIG_FAILED`         | Expected sandbox identity or artifact driver configuration              |
| `SEAT_MOUNT_LISTING_FAILED`        | Podman container listing command or listing shape, including row labels |
| `SEAT_MOUNT_SELECTION_FAILED`      | Exactly one workload generation and a usable physical container ID      |
| `SEAT_MOUNT_INSPECTION_FAILED`     | Initial Podman inspection command or single-container result shape      |
| `SEAT_MOUNT_IDENTITY_FAILED`       | Inspected container identity, required labels or running state          |
| `SEAT_MOUNT_PHYSICAL_PROOF_FAILED` | Unique artifact target, expected volume and physical access mode        |
| `SEAT_MOUNT_IMAGE_FAILED`          | Reviewed workload image identity                                        |

Existing native stages remain distinct: custody, native identity, native access and timeout, effective access proof, and the physical postcheck after native access. An unavailable native probe is a native-access failure. The outer `SEAT_MOUNT_VERIFICATION_FAILED` remains the fallback for mount evidence implementations that do not supply a recognized stage.

These codes identify where admission failed; they do not authorize remounting, replacement, retry, cleanup, lease release or owner adoption. A historical generic mount failure cannot be attributed to one of these stages without independent evidence. Offline tests inject listing, inspection and probe results, verify that stage codes survive reconciliation and creation-preflight wrappers, and retain all existing rejection checks. They make no native commands or model requests.
