# Canonical staging static foundation

This foundation validates independently prepared canonical owned release inputs
without importing an app, provider executor, native host, registry writer or
custodian launcher. It does not add a command that starts, installs, replaces or
stops a service. The canonical URL remains `http://mitzo-staging.localhost:3190`,
service identity `com.mitzo.staging` and private root
`~/.local/share/mitzo-staging`. Production is excluded.

Canonical source validation pins detached HEAD/tree, unchanged tracked source,
public origin, a published source ref and the recorded accepted-main baseline.
All tracked files must have ordinary Git index flags: assume-unchanged and
skip-worktree cannot hide unreviewed bytes. Offline integrity does not establish
fresh main, exact-head CI or final independent review.

Owned release verification distinguishes fresh preparation from retained input
verification. Retained verification permits owner-created workspace/state and
attestation evidence while rechecking immutable configuration, build and runtime
inputs. It never grants a new launch or reconstructs custody from a receipt.

The extended runtime pin catalog is static and staging-only. Canonical release
inspection can verify the separately pinned experimental images. Main's native
runtime selector and ordinary noncanonical owned-release selection retain their
existing catalog; this foundation does not enroll those images into a live host.

Five small contracts retain the consolidated candidate's validation while
removing implementation imports: registration schema, original controller
observation type, isolated launcher environment, network configuration predicates
and criterion definition schema. Existing launch/gateway modules re-export the
pure predicates, and the original controller observation remains a public type.
No protocol receipt or criterion executor is required to validate definitions.

Service preparation is a library that emits private fresh authentication and a
manually started plist. It requires canonical paths, capacity one and loopback
port3190. The registration/launcher/custodian implementation belongs to the
separate lifecycle cut; this foundation cannot bootstrap it. Original parent/app
observation and retirement validators are evidence checks, not native capabilities.

The ordinary controller acceptance, original registered launcher/registry,
no-force native exit, separately qualified transition controller and exact target
review remain separate prerequisites. A later transition must use the original
verified service handle and shared exclusive deployment lock, preserve state and
retain evidence after uncertainty. There is no activation exception, force kill,
lock deletion, production fallback or automatic rollback in this foundation.

The split manifest in `docs/operations/symposium-static-split-manifest.json`
records the immutable source and accepted-main baseline, extracted contracts and
intentional successor changes. Main may advance; the manifest does not grant
source acceptance, physical admission, provider enrollment or model-test authority.
