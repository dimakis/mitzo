# Local Mac personal Claude development

Personal subscriptions use the existing Claude Agent SDK development path with
the shared Mitzo permission handler. Native Bash, Grep and Glob are available
under those permissions, as they are for Vertex Claude. The personal account
does not add a second mandatory SDK Bash sandbox inside the protected SDK process.

On 13 November 2026, Dimitri explicitly prioritized restoring usable Local Mac
Claude and deferred the additional command-level credential sandbox. Its Unix
socket initialization conflicted with the outer process sandbox and prevented
ordinary Bash/repository work. Direct file requests targeting private account
paths still receive the existing denial; this is not complete credential isolation
for arbitrary shell commands or recursive searches. Do not claim otherwise.

Account identity, billing selection, revocation, shared command approval and the
existing outer controller protection remain enforced. Claude on OpenShell is
outside this increment. A future isolation change must preserve working native
repository commands and search, and qualify the complete nested execution path.

`claude-native-development.test.ts` drives the real installed SDK Bash tool with
canned localhost Messages responses and disposable repositories. It makes no
real model call. The ordinary-chat integration test separately verifies that the
actual personal startup options omit the extra sandbox while private direct
file requests remain denied.
