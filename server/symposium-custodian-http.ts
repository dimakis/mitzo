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
  });
  request.push(body);
  request.push(null);
  try {
    return await new Promise<CustodianResponse>((resolve, reject) => {
      const response = new ServerResponse(request);
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
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
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
  } finally {
    release();
    request.destroy();
  }
}
