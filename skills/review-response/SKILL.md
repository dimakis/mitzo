---
name: review-response
description: Investigate and triage PR review findings; use land-pr for the fixing and landing lifecycle.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

Fetch active review threads for `$ARGUMENTS` (PR URL, number, or current branch's PR). Read each finding and the referenced code; distinguish blocking bugs from explicitly non-blocking follow-ups and invalid or resolved findings.

Present a compact table of finding, evidence, severity and proposed action before making changes. Do not dismiss a finding merely because it is unlikely, or invent work to satisfy invalid feedback. Batch related fixes by root cause and preserve the intended scope.

This invocation remains read-only triage, including when `$ARGUMENTS` asks for fixes. Reading another skill cannot change the active tool ceiling. Present the concrete next command `/land-pr --prepare-only $ARGUMENTS` for a separate fixing invocation; when the user already authorized landing, that separate invocation may use canonical landing mode. Preserve authorization already given, but do not promise to start Edit/Write work inside this read-only turn or use Bash to circumvent its restriction. Do not run a second review/merge loop or infer merge permission from a triage request.
