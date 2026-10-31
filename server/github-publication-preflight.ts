import { SpanStatusCode, trace } from '@opentelemetry/api';
import { createLogger } from './logger.js';
import {
  GithubPublicationReviewError,
  safeGithubPublicationReviewFailure,
} from './github-publication-review-failure.js';
import { safeGithubSeedFailure } from './github-seeded-source.js';

export type GithubPublicationPreflightStage =
  | 'workspace'
  | 'inspection'
  | 'validation'
  | 'branch_policy'
  | 'export'
  | 'reconstruction'
  | 'review'
  | 'cleanup'
  | 'lookup'
  | 'approval_projection';

/** Only code-owned validation messages may become a public reason. */
export class GithubPublicationValidationError extends Error {}

/** One shared boundary for host, OpenShell and sealed-artifact publication.
 * Record only code-owned stages and public diagnostics: command/provider
 * exceptions can contain credentials, source content or authenticated URLs. */
export function githubPublicationPreflight<T>(
  operationId: string,
  signal: AbortSignal,
  run: (phase: (stage: GithubPublicationPreflightStage) => void) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('mitzo', '1.0.0')
    .startActiveSpan(
      'github.publication.preflight',
      { attributes: { 'publication.operation_id': operationId } },
      async (span) => {
        let stage: GithubPublicationPreflightStage = 'workspace';
        const phase = (next: GithubPublicationPreflightStage) => {
          stage = next;
          span.setAttribute('publication.stage', stage);
          span.addEvent('publication.phase', { 'publication.stage': stage });
        };
        try {
          const result = await run(phase);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const publicFailure =
            safeGithubPublicationReviewFailure(error) ?? safeGithubSeedFailure(error);
          const reason =
            error instanceof GithubPublicationValidationError ? error.message : undefined;
          const sanitized = new GithubPublicationReviewError('PUBLICATION_PREFLIGHT_FAILED', {
            stage,
            ...(reason ? { reason } : {}),
          });
          sanitized.message += ` Failed stage: ${stage}.${reason ? ` ${reason}` : ''}`;
          const failure = signal.aborted
            ? new DOMException('Publication cancelled', 'AbortError')
            : publicFailure
              ? error
              : sanitized;
          const code = signal.aborted
            ? 'CANCELLED'
            : (publicFailure?.code ?? 'PUBLICATION_PREFLIGHT_FAILED');
          span.setAttribute('publication.failure_code', code);
          span.setStatus({ code: SpanStatusCode.ERROR, message: code });
          createLogger('github-publication').warn('GitHub publication preflight failed', {
            operationId,
            stage,
            code,
          });
          throw failure;
        } finally {
          span.end();
        }
      },
    );
}
