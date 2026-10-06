import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/** Fixed-route HTTP/WS proxy: no glob patterns or recursive brace parser. */
export function createVoiceProxy(target: string, prefix: string) {
  const proxy = httpProxy.createProxyServer({ target, changeOrigin: true, secure: true });
  function stripPrefix(req: IncomingMessage) {
    const url = req.url ?? '/';
    if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'))
      req.url = url.slice(prefix.length) || '/';
  }
  return {
    http(req: IncomingMessage, res: ServerResponse) {
      // Express has already removed the mounted prefix; direct HTTP/upgrade
      // callers retain it. Both preserve the remaining path and query bytes.
      stripPrefix(req);
      proxy.web(req, res, {}, () => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Voice service unavailable.');
      });
    },
    upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
      const url = req.url ?? '/';
      if (!(url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'))) {
        socket.destroy();
        return;
      }
      stripPrefix(req);
      proxy.ws(req, socket, head, {}, () => socket.destroy());
    },
    close() {
      proxy.close();
    },
  };
}
