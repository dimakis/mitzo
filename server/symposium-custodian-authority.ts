import type { IncomingMessage } from 'node:http';
import type { CustodianRequest } from './symposium-custodian-protocol.js';
interface Authority {
  authorization: CustodianRequest['authorization'];
  assertCurrent(): void;
}
const requests = new WeakMap<IncomingMessage, Authority>();
/** Only the private in-process dispatcher can register an actual request object.
 * Neither headers nor JSON fields can manufacture this identity. */
export function bindCustodianAuthority(request: IncomingMessage, authority: Authority) {
  if (requests.has(request)) throw Error('Custodian request authority already bound');
  authority.assertCurrent();
  requests.set(request, authority);
  return () => requests.delete(request);
}
export function custodianRequestAuthority(request: IncomingMessage) {
  const authority = requests.get(request);
  if (!authority) return undefined;
  authority.assertCurrent();
  if (authority.authorization.expiresAt <= Date.now()) throw Error('Custodian operator expired');
  return authority.authorization;
}
