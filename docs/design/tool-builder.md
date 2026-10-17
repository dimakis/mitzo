# Tool Builder contract

Phase 4 adds a reusable Tool Builder profile that works through the regular
chat composer and profile system. It interviews the user, searches the installed
catalog first, and recommends reuse, an installed reviewed API template, or a
custom implementation draft.

## Draft boundary

The catalog and template readers are read-only. A draft is private review data;
it is not an implementation registration. A custom draft contains a name,
description, input schema, examples, permission behavior, compatible runtime
routes, relative source files, and test evidence. Files are written only through
the development workspace authority supplied to that builder session. The
workspace adapter rejects paths outside its root and does not accept absolute
paths, parent traversal, or symlink escapes.

The test runner accepts named repository test profiles and runs them through the
existing bounded sandbox executor. The builder cannot provide a shell command,
network destination, environment, credential, or sandbox policy. Test output is
bounded and the evidence is tied to a digest of the exact source-file set and
test profile. Editing any file invalidates prior test evidence. A failed,
cancelled, or incomplete run cannot be submitted as tested.

## Review and immutable publication

Draft edits create a new version. Feedback is attached to the submitted version;
revisions never mutate an accepted version. Submission freezes the version,
source digest, test evidence, schema, examples, permissions, and compatibility.
Only an independent accepted review can authorize publication. The submitting
builder cannot approve its own change.

Publication binds a tool identity and version to the exact reviewed source
digest and to a statically installed executor registration. The runtime never
imports, evaluates, or executes source from a draft, review bundle, API-tool
configuration, or workspace. Custom implementations become selectable only
when their accepted code is installed in the application registry and the
requested route has an executor. The publication receipt is append-only; later
revisions receive a new implementation version. Profile assignment remains a
separate user action and uses existing selection, admission, permission and
session snapshot rules.

If an equivalent installed tool exists, the builder proposes its immutable
reference and does not allocate a workspace or create another implementation.
Template recommendations refer only to templates the existing API tool owner
reports as installed. Neither recommendation changes profile selection.

## Failure behavior

Failed tests, denied review, cancellation, source drift, unavailable runtime
support, unsupported workspace authority, and unaccepted drafts leave the
catalog unchanged. Selection resolves an exact accepted identity/version and
current runtime support; labels and aliases never resolve a draft. Promotion,
credentials, broader permissions, and agent assignment require separate
explicit user actions.
