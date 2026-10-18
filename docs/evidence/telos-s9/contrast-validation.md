# Contrast contract correction before landing

The initial opt-in contrast diagnostic compared the Telos button directly to
`--color-on-accent`. New proposed S7 source exposed that assumption: the existing
shared `.todo-detail-chat-btn` correctly uses the theme's paired background role,
with slightly different values. A valid shared component should not fail solely
because it selects a different correct semantic token.

S9 now compares the actual foreground to the same shared component rendered
outside the Telos cascade, and independently measures at least4.5:1 foreground /
background contrast. This is the existing filled-control requirement in
`docs/design/ui-design-system.md`. The failure assertion is not weakened to accept
the original low-contrast state. The original reports/captures remain unchanged.

Recheck of original compositionc6e55fb9: four required cases fail, two browser
startup controls pass, zero skips. Desktop Chromium and mobile WebKit both measure
**1.356:1 dark** and **2.506:1 light**, below4.5:1. They also disagree with the
actual shared reference foreground. The [raw report](contrast-original.json) and
[log](contrast-original.log) are separate from the earlier token-specific report.

The other audit hashes in audit-results.json describe the original207901b source.
For the evolved ui.contract.ts file, use git show207901b:tests/integration/telos-s9/ui.contract.ts
or retained S9 archivee5a82ce2b46a0c53be9eb5c66f603c0f@r1 to recover those exact
historical bytes. [This supplement's hashes](contrast-validation.json) identify the
current corrected contract. No historical result is rewritten.

The same corrected contrast case passes all four theme/browser combinations on
proposed S7 consumer187811f9 plus repaired shared viewerf9409978 (two additional
startup controls also pass). The case source is identical in both rechecks; the
proposed follow-up suite has unrelated changes outside the selected cases. See
[proposed-source report](contrast-proposed-repair.json). This verifies the test
distinguishes the defect from the fix; it is not accepted-source or UX signoff.

Separately, proposed S7 consumer187811f9 plus repaired shared-viewer producerf9409978
is being verified in an isolated follow-up. That consumer composition, its results,
UI acceptance, priority authority repair and producer acceptance are outside this
frozen evidence increment. No new production source is included here. S9/parent
remain active; live qualification remains pending separate authorization.
