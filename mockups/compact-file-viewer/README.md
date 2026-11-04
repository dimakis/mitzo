# Compact file viewer preview

`v007.html` is the retained self-contained preview exercised by the offline browser
tests. Generate the next revision with `node scripts/render-compact-display-preview.mjs`.
Revision numbers advance beyond the highest retained revision.

On 4 November 2026, the user approved removing generated revisions v002–v006 from
PR #1191 to keep its complete diff within Centaur's 16 MiB review limit. Their
bytes remain in the original task workspace and in
[commit b336631e](https://github.com/dimakis/mitzo/tree/b336631e4090faee7844f8a16f342401a79b7619/mockups/compact-file-viewer).
The retained copies were checked byte for byte against that commit before removal.
The generator, fixture sources and all browser assertions remain in this PR.

Recover any historical version without changing the current preview:

```bash
git show b336631e4090faee7844f8a16f342401a79b7619:mockups/compact-file-viewer/v002.html > /tmp/compact-file-viewer-v002.html
```
