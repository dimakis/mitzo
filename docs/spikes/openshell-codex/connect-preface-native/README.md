# CONNECT payload preservation

The supervisor's CONNECT header read can consume the first tunnel bytes in the
same read. The header parser previously discarded that tail. The repair replays
the bounded tail once before the original buffered reader, retaining the original
write side. Authorization, endpoint selection, TLS inspection, credentials and
the CONNECT response remain unchanged.
The protocol detector consumes incomplete prefixes so its reader can refill,
then restores every consumed byte before TLS inspection or relay. It retains the
existing peek limit and initial idle behavior.

`native.patch` applies to the retained diagnostic source recorded in
`../routing-diagnostic-native/source-qualification.json`. The original public
dependency closure and both predecessor commit objects remain in that directory.
`native-commit.txt` preserves the successor's DCO commit object, including its
tree and parent. `qualify-source.mjs ABSOLUTE_PUBLIC_SOURCE_CHECKOUT` reconstructs
all four commit objects from the pinned public upstream and checks the exact
final tree and archive. It performs no network or model request.

The regression uses the actual virtual bridge and CONNECT handler with an
authorized local mock upstream. It checks coalesced TLS bytes, plaintext HTTP,
an empty tunnel and a fragmented CONNECT boundary. The TLS-prefix and plaintext
cases first failed because the upstream received zero bytes. The mock echoes the
payload to verify exact bytes in both directions and the hidden synthetic response.
The fifth case checks one- and two-byte prefixes followed by later tunnel data.

Release qualification uses the same installed tools, isolated environment,
locked offline dependency cache, two-job limit and 900-second build deadline as
the predecessor. Source and artifact receipts bind the actual CLI and supervisor
hashes and executed versions. The image recipe preserves the original 29 base
layers and runtime configuration with one replacement ELF layer. Version-only
qualification uses no network, mounts, credentials or inference and requires
confirmed cleanup.

Source registration and physical runtime adoption remain separate. The accepted
staging controller selects the exact measured successor; the running owner is
replaced only through the existing canonical update workflow. A qualified build
does not establish a successful Personal account read or Symposium turn.
