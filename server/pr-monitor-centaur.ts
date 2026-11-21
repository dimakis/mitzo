import { createHash } from 'node:crypto';

/** Read-only convergence evidence matching the repository's Centaur publishing
 * format. A report-level finding retains the exact report digest/reference;
 * prose, code blocks and recommendations never become executable instructions.
 * This parser is not a landing gate or an LGTM/merge authorization. */
export function parsePrMonitorCentaur(body: string) {
  const marker = /^<!-- centaur:sha:([a-f0-9]{40}) -->\s*## Centaur Review(?:\r?\n|$)/.exec(body);
  if (!marker) return null;
  if (
    Buffer.byteLength(body) > 16384 ||
    [
      '<!-- centaur:sha:',
      '## Centaur Review',
      '### Convergence',
      '**Recommendation:**',
      'New blocking findings:',
      'Unresolved blocking findings:',
    ].some((token) => body.split(token).length !== 2)
  )
    throw Error('incomplete');
  const tail = body.slice(body.indexOf('### Convergence'));
  const recommendation = /^\*\*Recommendation:\*\* `(merge|fix|human_decision)`[^\r\n]*$/m.exec(
    tail,
  )?.[1];
  const fresh = /^- New blocking findings: (0|[1-9][0-9]{0,3})[ \t]*\r?$/m.exec(tail)?.[1];
  const unresolved = /^- Unresolved blocking findings: (0|[1-9][0-9]{0,3})[ \t]*\r?$/m.exec(
    tail,
  )?.[1];
  if (
    !recommendation ||
    fresh === undefined ||
    unresolved === undefined ||
    recommendation === 'human_decision'
  )
    throw Error('incomplete');
  const blocking = Number(fresh) + Number(unresolved) > 0;
  const cleanPrefix =
    /^<!-- centaur:sha:[a-f0-9]{40} -->\s*## Centaur Review\s*LGTM — no issues found\.\s*### Convergence\s*/.test(
      body,
    );
  if (
    (recommendation === 'merge' && (blocking || !cleanPrefix)) ||
    (recommendation === 'fix' && (!blocking || cleanPrefix))
  )
    throw Error('incomplete');
  return {
    headSha: marker[1],
    state: blocking ? ('changes_requested' as const) : ('approved' as const),
    findings: blocking
      ? [
          {
            id: 'centaur-report',
            revision: createHash('sha256').update(body).digest('hex'),
            blocking: true,
            resolved: false,
          },
        ]
      : [],
  };
}
