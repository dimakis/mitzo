# Default CI discovery follow-up

The dedicated `.test.ts` / `.test.tsx` entry points import the retained contract
bodies unchanged. Default Vitest discovery now includes all four contracts. The
first entry-point run had three passes and one delegation failure: the client
reported `Telos work unavailable` before the injected committed-response-loss
assertion. The cause was not established; this is not recorded as a production
defect, a fixed defect or an expected rejection. Its JSON report is retained.

A temporary catch around the existing S9 delegation fixture was used only for
diagnosis. Fifteen bounded, sequential single-contract runs and a combined run
passed without reaching that catch; the cause remains unproven. The diagnostic
was removed. The final unchanged-fixture/default-discovery run passed all four
cases, zero skipped. `publication-final.json` and `.log` retain that result.
The original 97054299 fixture and contract bodies remain byte-identical. CI and
trusted review are separate gates; this offline result does not claim those gates
or close S9, its parent, full journeys, UX or live qualification.
