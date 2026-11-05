# Native Codex subagent implementation evidence

Recorded 5 November 2026. The final v005 mock is retained byte for byte from
the originating conversation's mockups/mitzo-subagents directory. That
conversation (911e7aaf-f8a0-8aaf-862e-c322cfd6c163) contains the user's approval:
“yep, this is excellent, I like this. lets just ensure that we don't get rid of
the other icons in the screen chat, for terminal etc. the mock has left these out”.
Subsequent refinements preserved toolbar actions, phone layout, context wheel
and Resources. The current user explicitly requested implementation.

The implementation uses existing shared dialog, text, tool and icon components.
Component tests cover parent and sibling draft preservation, targeted controls,
uncertain request identity and retained unavailable output. The offline browser
fixture mounts the real composer and child UI at phone and desktop widths,
in light and dark themes, including touch geometry, focus and Terminal checks.
The ledger protects these test sources and the original reference.

Local evidence before final preparation: 452 existing conversation tests passed;
37 focused tests across six files passed. Store tests and package builds also
passed. An earlier full server type check exceeded the configured 1GiB heap;
a focused server type check passed. A focused frontend type check lacked the
Vite environment declaration in its temporary include list. These do not replace
the repository's full CI checks.

The browser invocation was interrupted before a result. No browser pass,
screenshot comparison or live model execution is claimed. At the user's
direction, final combined-source validation and rendered browser checks run in
CI. Review their retained screenshots against the approved reference.

This evidence does not establish production activation, upstream live child
inheritance, deployment or final user acceptance. No production runtime was
changed. The Telos creation tool did not create an outcome; code and this
document preserve the implementation handoff.
