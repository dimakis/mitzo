import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Request, Response } from 'express';
import { createAppSecurityHeaders } from '../../server/security-headers';

/** Invoke the actual middleware without binding a port or starting an app. */
export function deployedSecurityHeaders(): Record<string, string> {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  const response = new ServerResponse(request);
  createAppSecurityHeaders()(request as Request, response as Response, (error?: unknown) => {
    if (error) throw error;
  });
  socket.destroy();
  return Object.fromEntries(
    Object.entries(response.getHeaders()).map(([key, value]) => [key, String(value)]),
  );
}
