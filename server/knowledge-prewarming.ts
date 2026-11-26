import { knowledgePublicationFailureDiagnostic } from './knowledge-publication-bridge.js';

type PrewarmLog = Record<
  'warn' | 'info' | 'debug',
  (message: string, data: Record<string, unknown>) => void
>;

/** Bounded reporting for a periodic optional warmup: warn on the first failure and
 * on each change of stage/code/status, count identical repeats at debug, and log
 * one recovery line. Diagnostics are sanitized and can never stop the loop. */
function prewarmReporter(log: PrewarmLog) {
  let reported: string | undefined;
  let consecutiveFailures = 0;
  const safely = (report: () => void) => {
    try {
      report();
    } catch {
      /* An unavailable log sink must not end prewarming or reject the interval. */
    }
  };
  return {
    failed(error: unknown) {
      consecutiveFailures++;
      safely(() => {
        const diagnostic = knowledgePublicationFailureDiagnostic(error);
        const key = JSON.stringify([diagnostic.stage, diagnostic.code, diagnostic.status]);
        const data = { ...diagnostic, consecutiveFailures };
        if (key === reported) log.debug('Knowledge conversion prewarming still unavailable', data);
        else {
          reported = key;
          log.warn(
            'Knowledge conversion prewarming unavailable; commands retain fresh admission',
            data,
          );
        }
      });
    },
    succeeded() {
      if (!consecutiveFailures) return;
      const recovered = consecutiveFailures;
      consecutiveFailures = 0;
      reported = undefined;
      safely(() =>
        log.info('Knowledge conversion prewarming recovered', { consecutiveFailures: recovered }),
      );
    },
  };
}

/** Prepare format conversions ahead of sends; never grant a command a knowledge selection. */
export function startKnowledgePrewarming(
  store: { prewarm?(signal: AbortSignal): Promise<unknown> } | undefined,
  options: { intervalMs?: number; log: PrewarmLog },
) {
  if (!store?.prewarm) return undefined;
  const abort = new AbortController();
  const report = prewarmReporter(options.log);
  let pending: Promise<void> | undefined;
  const refresh = () => {
    if (abort.signal.aborted || pending) return;
    pending = (async () => {
      try {
        await store.prewarm!(abort.signal);
        report.succeeded();
      } catch (error) {
        if (!abort.signal.aborted) report.failed(error);
      }
    })().finally(() => {
      pending = undefined;
    });
  };
  refresh();
  const timer = setInterval(refresh, options.intervalMs ?? 30_000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}
