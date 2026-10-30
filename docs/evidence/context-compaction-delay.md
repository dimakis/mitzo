# Context compaction delay, 30 October 2026

Read-only inspection of an existing Host Mac Codex API conversation established
that this wait occurred inside Codex's remote compaction request, rather than
Mitzo queuing work or delaying the completion notification. No diagnostic model
call, service restart, staging operation or production mutation was performed.

All times below are UTC (also Europe/Dublin on this date).

| Observation                                                          | Time                         |
| -------------------------------------------------------------------- | ---------------------------- |
| Mitzo receives compaction start                                      | 12:00:32.702                 |
| Codex logs an unhandled `response.compaction.compacting` event       | 12:00:35                     |
| Codex reports a WebSocket idle timeout and retries remote compaction | 12:05:35                     |
| Codex reconnects to OpenAI                                           | 12:05:36–37                  |
| Further progress events are logged as unhandled                      | 12:05:42, 12:06:12, 12:06:42 |
| Codex writes the completed compaction to its rollout                 | 12:07:05.338                 |
| Mitzo persists the completion event                                  | 12:07:05.371                 |
| First fresh usage accepted by Mitzo afterward                        | 12:07:13.854                 |

The observed start-to-completion duration was **392,669 ms (6m 33s)**.
Runtime completion reached Mitzo in approximately **33 ms**. The initial attempt
waited for the runtime's five-minute idle timeout; its retry then completed.
The logs do not establish why OpenAI's first stream stopped progressing, or
whether the transport or remote service caused the disconnection. Changing
Mitzo's timers or restarting it would not diagnose that cause.

The last usage reading before the start was 189,054 tokens against a 258,400-token
runtime context limit. This was not the compactor's trigger measurement: Codex's
private log reported a 248,226-token auto-compaction scope against a 244,800-token
scope threshold after tool work. These are distinct measurements. The first
fresh subsequent response reported 28,549 tokens. The runtime's intermediate
post-compaction estimate was 32,299, carried in a zeroed usage breakdown that the
existing accounting validator does not accept. It is not substituted for an
exact after-size or final turn accounting.

The rollout's readable summary field was empty. It retained recent attributed
messages alongside an encrypted compaction item; that does not establish a
complete human-readable summary or an exact application-message condensed range.
The dialog does not read private rollout files or expose private runtime paths.

## Dialog behavior

The compaction-history endpoint joins two bounded, session-scoped metadata reads:
up to 512 lifecycle events and 1,024 recent usage events. It does not load message
or tool bodies. Start and terminal timestamps remain separate from the latest
lifecycle observation. A missing start, including truncated history, gives no
invented duration.

Nearby context readings are labelled **Last observed before** and **First observed
after**. Explicit compaction sizes, when supplied, retain **Reported before/after**
labels. After-readings require fresh timestamped runtime usage from the same turn
and model, after confirmed completion and before any later compaction. A repeated
old reading at completion, an interrupted compaction or an unproven smaller number
does not establish reduction. Missing observations remain unknown.

The open dialog ticks elapsed time locally without polling, distinguishes waiting
from failure, shows the observed model and context limit, and displays summary or
retained IDs only when supplied. Original chat history remains browsable. The
client refreshes for the first subsequent usage reading while that same completed
turn still needs one, then stops refreshing on usage changes.

Focused regression and browser validation are recorded in the PR. Broad builds,
the full offline UI suite and final combined-source checks remain CI gates when
the host reports warning memory pressure.
