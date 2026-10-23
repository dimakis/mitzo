# Pinned native alias qualification

`scripts/qualify-codex-native-aliases.mjs` uses official Codex `0.160.0`, digest
`112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`, and synthetic
named profiles through actual `command/exec`. All files, credentials and mutations
are disposable. It makes no model calls and uses no account, production or staging
configuration. Run outside an existing macOS Seatbelt sandbox:

```sh
node scripts/qualify-codex-native-aliases.mjs /absolute/pinned/codex
```

The checked-in JSON records the observed results. The diagnostic exits **1**
because the deliberately host-preexisting hardlink cases violate the broader
original-unchanged/read-denied invariants. `testedNativeControlsPreservedOriginals`
is true for the specific native creation/replacement controls below; it is not a
claim about every possible operation or all host content.

| Exact precondition and operation                                                                                             | Actual result                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Public source readable but not writable by policy, initial link count 1, OS mode `0444`; native `ln` into writable workspace | Denied; no alias write attempted, original unchanged.                                                                                |
| Same read-only policy with owner-writable OS mode `0644`, initial link count 1                                               | Native `ln` denied; original unchanged.                                                                                              |
| Positive control: mode `0644`, source explicitly writable by policy                                                          | Native `ln` and alias modification succeed, changing the source as authorized. This distinguishes policy enforcement from Unix mode. |
| Credential source denied by exact path and absolute glob, initial link count 1; native `ln` into workspace                   | Denied; no alias read attempted. Direct credential read also denied.                                                                 |
| Host creates public-file hardlink in writable workspace before sandbox construction                                          | Alias modification changes the original inode despite its protected original pathname.                                               |
| Host creates credential hardlink in workspace before sandbox construction                                                    | Alias read succeeds despite the original credential pathname/glob denial.                                                            |

The last two controls have a distinct prior-authority assumption: the host already
made the alias, so the source link count is 2. They do not prove the sandbox can
create that alias from a single-link protected source. Conversely, a pathname
fence cannot be described as an immutable inode classifier on their evidence.
Admission and custody of selected authority-bearing files must account for their
actual physical identities/link state, or explicitly exclude this precondition.
This report does not propose a global credential scanner or a claim about arbitrary
user content.

Writable roots also differ from readable roots. An initial symlinked writable root
is rejected before execution with RPC error `-32603`, "symlinked writable roots are
not supported." Ordinary workspace authority can replace that symlink, but the
next attempted explicit writable-root operation is still rejected. A real writable
directory is admitted; native rename/replacement of its root is denied. After the
host replaces it with a symlink into public read-only runtime data, the next
sandbox construction rejects the operation and leaves the protected file unchanged.
The proposed retained-writable-root symlink bypass was therefore **not reproduced**.

The pinned error identifies `allow_symlinked_codex_home=true` as a separate opt-out
only for roots at/below `CODEX_HOME`, explicitly trusting targets changed between
commands. This fixture leaves that opt-out unset and uses workspace roots outside
`CODEX_HOME`. It does not qualify the opt-out.

Parser/remedy controls show that `read` with trailing `/**` is accepted as subtree
access, while a general brace glob such as `/public{,/**}` with `read` is rejected:
"only supports `deny` access." An absolute `deny` glob blocks both reads and writes
through the protected pathname; it also blocks native hardlink creation from that
pathname. It still does not protect a host-preexisting hardlink under another name.
Thus changing readable public runtime roots to `deny` both removes required reads
and fails to supply an inode-aware remedy for pre-existing aliases.

The existing direct native helper qualification remains a separate measured route;
these alias controls do not add a new executor or assert extra protections for it.
All tested protected bytes changed by prior-host-alias or authorized-positive
controls are restored before the disposable root is removed. Native enablement and
the owning runtime's physical-custody policy remain separate decisions.
