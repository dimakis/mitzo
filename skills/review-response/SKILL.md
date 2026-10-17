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

This skill is read-only triage. If the user has requested fixes or landing, continue through the available `land-pr` skill (normally `../land-pr/SKILL.md`) using the authorization already given. Otherwise report the proposed fixes. Do not run a second review/merge loop or infer merge permission from a triage request.
