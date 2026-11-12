import express from 'express';
import { request } from 'node:http';

/** Forward only to the currently owned private child; retain stream cancellation. */
export function createJoinedChildProxy(target: () => number | undefined) {
  const proxy = express();
  proxy.use((req, res) => {
    const port = target();
    if (!port) {
      req.socket.destroy();
      return;
    }
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    // A browser may disconnect while the child is still preparing SSE headers.
    // Register now: waiting for the response loses that cancellation permanently.
    res.on('close', () => upstream.destroy());
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return proxy;
}
