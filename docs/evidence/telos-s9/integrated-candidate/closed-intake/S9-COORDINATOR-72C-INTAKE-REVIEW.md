# S9 corrected coordinator 72c evidence intake

**PASS for bounded source/evidence integrity; no new actionable finding.** The two original coordinator P2s have independent same-case candidate RED→GREEN evidence on exact 72c, consistent with `S8-COORDINATOR-CORRECTIONS-REVIEW.md`. Accepted-main integration, publication ownership, full UX and live acceptance remain open. S9 remains the independent acceptance owner; root retains accountability.

Reviewed producer `72c20ef2b6eb70217953356f58be98619fac2d92`, tree `c2da367dc3eb0d0f6f8abf23996ecae238cb0235`, direct parent `b3d8e6935c2e27bd5c0145c90ecb36839d4ea83b`; refresh execution `46c1106e37cba9aca5e77a8b9682b1a5bce78989`; final core execution `e446b5d0f20d4579a5cdb6bcaf82a99b3a7961d1`, tree `41917a3c4f385094dee80e03b1eb0e7daea4539f`. Read the complete targeted case, core delta, prior 33fc review, correction review and retained source/result/diagnostic evidence. Detailed hashes/checks are in `S9-COORDINATOR-72C-INTAKE.json`.

## Independent candidate correction evidence

The targeted case and config are **byte-identical** to original RED execution `9fbaf87e55853e8c937ffc79c73871a03bc78883`. Original 33fc records **0 pass / 1 fail / 0 skip, three strict assertion failures**; corrected 72c records **1 pass / 0 fail / 0 skip, 11.06 s**.

`coordinator-refresh-browser.contract.ts:113–148` aborts only the unrelated Job record transport and checks real attached-scope priority/Send controls. The old source queried Job once and disabled both; 72c does not query it and keeps both enabled. Its initial soft assertions still fail the test while allowing the independent race reproduction to proceed.

For the second P2, actual reviewed setup replaces the coordinator assignment. The test holds only the canonical work GET, destroys the real broadcast SSE transport and waits for actual reconnect, inbox completion and all six attached record requests to finish. It supplies no fabricated response: the held request later uses `route.continue()` (`:164–228`). Old 33fc left Release enabled; corrected 72c disables it. Continuing the actual GET returns the replacement assignment, removes the old surface and preserves the original hold, with zero native launches (`:229–248`). This independently corroborates both source closures without expanding to every refresh/authority scenario.

## Retained core plus actual desktop

Every original 33fc core line remains in order after normalizing only the helper's additive scope type union. Existing real roles/delegation/TaskOrchestrator, ten distinct native ACKs plus duplicate replay, standard Allow Once flow, one host-denial applied event, unrelated Job completion, restart and released-publication/revalidation checks remain intact.

Final e446 adds actual 1280 desktop readiness and a supported `new_worker_dispatch` priority/scope/request/read/release sequence (`coordinator-controls-browser.contract.ts:563–636`). It checks real requested state with empty history, exact read equality, released state with empty history, no Release button after release and correct capture framing. The original eleven native owners still each have one turn and zero interrupts; no second ACK cycle or extra native work is introduced. Final core records **1 pass / 0 fail / 0 skip, 40.41 s**. The earlier 39.13 s core run is retained as prior evidence, not a third selected case.

Thus this intake contains **two selected cases total, two passes and zero failures/skips**. It does not establish a complete required-nine run or complete desktop/device UX qualification.

## Source and evidence integrity

All six successor inventory paths and the prior fifteen owner paths (except the separately reviewed successor changes) match the selected immutable producer. Both executions differ from 72c only in dedicated S9 prefixes and four exceptions byte-identical to published faad. Shared helper, original nine required case files, frozen chooser and plan remain unchanged. The runner stays `a08dfd1e…`; no case was added to its required selection. Delivery `89de0abc9bb62c50dbe1dda258d9b593314a063b` changes only two evidence documents after final execution.

All declared case/helper/config/runner/plan hashes, selected/prior/RED raw result hashes, **11 capture hashes** and **2 archive hashes** verify. Both proof observation objects deep-equal the original diagnostics files. Source-proof SHA-256 is `118ecb60f30280b9b2b579ef134346730cafe6caf0704e2235aabf918ab58374`; final core source is `0aa5c6c1ae9805de414850b88bdbe53cf9d7ab8b283bcdff04ec248c5738183c`. Final raw hashes are refresh `283a4bfc…` and core `63238d3b…` (full values in the machine report).

The prior producer combined WebKit reload/access-control failure and unchanged assertion/trace remain retained; later diagnostic repeats and these selected Chromium passes do not turn that broader campaign into a zero-failure result. Actual shared-main publication/current revision validation still lacks its separately approved owner. Current CI/trusted review, accepted-main repeat, full UX/recovery/coexistence/device breadth and separately authorized live work remain open.

No tests, models, network, browsers or services ran. No owner messages, source/index edits, publication or merge actions occurred; only the two root review artifacts were written.
