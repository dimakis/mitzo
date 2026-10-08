import type { CapabilityApproval } from './connections/capabilities/types.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import { bindCustodianAuthority } from './symposium-custodian-authority.js';
import {
  custodianRoute,
  decodeCustodianRequest,
  type CustodianRequest,
} from './symposium-custodian-protocol.js';
import type { CustodianResponse } from './symposium-custodian-controller.js';
/** Runs existing semantic validation without opening a network listener. */
export async function dispatchCustodianHttp(
  app: Express,
  input: CustodianRequest,
  assertCurrent: () => void,
  publicationApproval?: CapabilityApproval,
  publicationSignal?: AbortSignal,
): Promise<CustodianResponse> {
  const command = decodeCustodianRequest(input);
  assertCurrent();
  const route = custodianRoute(command);
  const request = new IncomingMessage(new Socket());
  request.method = route.method;
  const query = new URLSearchParams(command.query).toString();
  request.url = route.path + (query ? `?${query}` : '');
  const body = JSON.stringify(command.body);
  request.headers = {
    host: 'custodian.invalid',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  const release = bindCustodianAuthority(request, {
    authorization: command.authorization,
    assertCurrent,
    publicationApproval,
    publicationSignal,
  });
  request.push(body);
  request.push(null);
  const response = new ServerResponse(request);
  let completed = false;
  let failed = false;
  let failure: unknown;
  let result: CustodianResponse | undefined;
  try {
    result = await new Promise<CustodianResponse>((resolve, reject) => {
      let settled = false;
      // All enumerated handlers return a bounded JSON response. Streaming,
      // redirects, cookies and arbitrary response headers are not transported.
      response.end = ((chunk?: unknown) => {
        if (settled) return response;
        settled = true;
        try {
          assertCurrent();
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : typeof chunk === 'string'
              ? chunk
              : '';
          if (Buffer.byteLength(text) > 16 * 1024 * 1024)
            throw Error('Custodian response too large');
          const result = { status: response.statusCode, body: text ? JSON.parse(text) : null };
          completed = true;
          resolve(result);
        } catch (error) {
          reject(error);
        }
        return response;
      }) as typeof response.end;
      app(request as Request, response as Response, (error?: unknown) => {
        if (!settled) {
          settled = true;
          reject(error ?? Error('Custodian semantic handler unavailable'));
        }
      });
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    // This transport finishes a bounded semantic response, not an HTTP socket
    // write. Notify existing route cleanup hooks without forging socket flags.
    // Rejected responses close the request instead of reporting completion.
    response.emit(completed ? 'finish' : 'close');
  } catch (error) {
    // A cleanup listener must not replace the original rejection.
    if (!failed) {
      failed = true;
      failure = error;
    }
  } finally {
    release();
    request.destroy();
  }
  if (failed) throw failure;
  return result!;
}
