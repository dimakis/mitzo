# Reusing verified Local Codex code

New Local Codex conversations previously copied the reviewed native executable
and its companion into each private login home. An isolated diagnostic showed
that each fresh copy incurred approximately two seconds on first execution.
Removing `--version` merely moved that cost into initialization.

The follow-up to parallel startup retains one process-owned code bundle per
unchanged source identity/private root. API and subscription conversations reuse
the same verified code files while keeping independent private login homes,
credentials, configuration, native state and processes. There is no shared login
or credential/readiness cache. OpenShell, Claude and Gemini do not use this Local
Codex executable-copy path.

## Ownership and compatibility

The registry publishes only complete main/companion custody snapshots after the
existing exclusive capture, hash and fsync checks. Snapshots are immutable; each
conversation receives a fresh wrapper bound to exactly one private home. Shared
placement records the private root's physical identity and validates bundle
ancestry, private directory ownership/modes and login-home identity. Source and
owned-file inode/link/mode checks, full launch hashes and version checks remain.

Closing or failing one conversation does not delete code used by another. No
code files are evicted in this change. A source update allocates a new bundle;
retained custody continues to use its exact original files and existing
fail-closed source checks. A corrupt registry entry can be discarded for new
adoption without repairing or rebinding retained conversations. Unexplained disk
directories are never scanned/adopted; a process restart begins with an empty
registry. The first new bundle execution after restart/source replacement still
incurs the cold cost.

Legacy code-inside-login-home custody remains supported, including its recorded
companion-upgrade path. New shared snapshots carry explicit placement evidence
and reopen their exact recorded bundle on cold continuation. Builds predating
shared placement cannot consume these new snapshots; deployment/rollback planning
must retain a build that understands them. No custody is deleted or migrated.

## Account-free native layout diagnostic

The exact reviewed native bytes were copied to a disposable sibling code bundle,
then initialized in three distinct private homes. Before native execution, an
explicit macOS OS sandbox was proved to deny loopback networking, real-home reads
and writes outside the fixture. Keychain files and securityd lookup were also
denied. Children inherited only an explicit minimal environment with disposable
HOME/CODEX_HOME and file-only credential storage. The provider was an offline
endpoint with OS-denied networking.

| New private home using the same code inode |      Version | Initialize |     Combined |
| ------------------------------------------ | -----------: | ---------: | -----------: |
| First execution                            | 2,199.917 ms | 122.885 ms | 2,322.802 ms |
| Second home/process                        |    54.346 ms |  84.939 ms |   139.285 ms |
| Third home/process                         |    52.693 ms |  88.805 ms |   141.498 ms |

All three native sessions received only `initialize`/`initialized` and exited on
stdin EOF. Companion `--help` succeeded under the same policy. Code hashes and
inode remained unchanged; the code directory contained only the two executable
files and the three homes had distinct physical identities. The initial copy
took 1,376.224 ms in this Python fixture and is excluded from the table.

No account, credential, model, thread, turn, tool or backend operation was made.
No model was invoked and no account was charged. Temporary files were removed.
This small diagnostic qualifies the sibling layout and illustrates the first
execution penalty; it is not a benchmark of the complete application path.
The precise macOS subsystem responsible for the cold penalty was not identified.

Synthetic application regressions separately cover API/subscription ownership,
independent clients/homes, cold legacy/shared custody, source updates, partial
capture, immutable publication, tampering and home/root substitution. Fresh
measurement and full launch hashing still cost time. Total live startup with
parallel setup and code reuse remains unmeasured; subsecond cold startup is not
established by these results. No service restart, deployment or staging operation
is included.

## Fresh profile observations within authorization fences

Signed-native CI discovery exposed the cost of repeated authorization fences.
Each synchronous bootstrap fence previously loaded the account-profile view
twice. It now captures the existing selection observers in their existing order,
then loads one fresh view for routing and every pending model validation. No
view survives another fence, await or native effect. Account/provider/revision,
selection, login, executable and physical ownership checks remain; discovery
deadlines and required coverage are unchanged.

Regression tests cover profile mutations by both selection observers, changes
between fences and across an awaited workspace check, and pending model
validation. A synthetic one-account fixture measured a median of 158.183 ms
before and 126.017 ms after per 1,000 fences, with profile loads reduced from
2,000 to 1,000. This roughly 20.3% component improvement does not establish
whole-admission, CI discovery or end-to-end startup timing.

## Avoiding a duplicate native-reader entry check

Logical path authorization previously performed three fresh compound owner
checks: after its first additional ceiling, at native-reader entry, and after
its final ceiling. The real reader performs its entry check synchronously before
any path lookup or effect. A factory-private identity registry now proves that
exact frozen reader and its retained entry callback, allowing its fresh entry
check to replace the first duplicate. Both ceiling callbacks and the final
post-await owner check remain. The registry stores implementation provenance,
never a successful authorization or filesystem observation.

Generic, copied and proxied readers retain all three checks. Physical owner
changes, revocation, abort, disposal and expiry still fail fresh checks; native
helper spawn/result and final cached-fact verification fences are unchanged.
Scratch-only regressions verify two checks for the actual factory reader and
three for generic copies, including mutations during both ceiling waits and
before entry. Signed CI retains all 17 required cases and the same deadlines;
reads report timing profiles on both success and failure.
The reduction in duplicate work does not establish end-to-end startup latency.

## Separating reader construction and measuring the remaining cost

The reader implementation and its private provenance registry live in a module
that does not import runtime context or authentication wiring. Context-specific
wrappers retain their original scope and owner callbacks. This removes an import
cycle introduced by the provenance lookup; that cycle bypassed the controlled
prepared-reader fixture on Linux. A regression selects Linux only during fixture
adoption and verifies the intended reader and creation callbacks are used.
The physical factory, guards, helper boundaries and provenance checks are moved
without changing their behavior; there is no arbitrary registry insertion API.

The signed read suite now installs test-only synchronous stage counters before
constructing owners. It reports call counts, inclusive and exclusive time,
recursion, setup separately from dispatch, and reader-deadline/helper windows.
Wrappers retain the original receiver, arguments, result, exception and Promise
identity. One bounded numeric aggregate is emitted on success or failure; it
contains no source paths, credentials or tool input/output. Required assertions,
all 17 signed cases and their deadlines remain unchanged. Nested inclusive,
async-admission and helper timings overlap and must not be added together.
These diagnostics identify the remaining cost; they do not establish subsecond
startup or justify reusing an earlier authorization result.

## Reusing query programs while reading current state

The native conversation store lazily prepares six fixed read statements once
per store/database. Every call still executes its original SQL with current
parameters, reads fresh rows, and applies the same binding, thread, attempt,
status, custody and pending-tool checks in the same order and transactions.
No row, account binding or successful authorization is retained. Independent
stores own independent statements; preparation failures can be retried and
closed stores still reject reads.

A synthetic 2,000-round fresh-read loop measured median elapsed time of
660.955 ms before and 175.409 ms after, about 73.5% lower for that component.
This does not establish whole-admission or end-to-end startup timing. Tests
count actual executions as well as preparations and mutate ownership/status
rows between reads to prove that statement reuse does not reuse results.

The required Mac journey also records bounded numeric milestones, including
its dynamic imports and fixture setup, before existing teardown. Its 60-second
deadline and all assertions remain unchanged. Independent joined and signed
acceptance steps now continue after an earlier failure unless cancelled, so
all required coverage and timing diagnostics can be collected in one run.
An earlier failed step still fails the job and final CI gate.
