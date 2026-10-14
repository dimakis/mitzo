import express, { type ErrorRequestHandler } from 'express';

/** Mount behind authMiddleware, before the application's JSON body parser. */
export function createTelemetryRelay(endpoint?: string, forward: typeof fetch = fetch) {
  const router = express.Router();
  if (!endpoint) return router;
  const target = new URL(`${endpoint.replace(/\/$/, '')}/v1/traces`);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('Invalid telemetry collector endpoint');

  router.post(
    '/v1/traces',
    (req, res, next) => {
      if (!req.is(['application/json', 'application/x-protobuf'])) return res.sendStatus(415);
      next();
    },
    express.raw({
      type: ['application/json', 'application/x-protobuf'],
      limit: '1mb',
      inflate: false,
    }),
    async (req, res) => {
      const controller = new AbortController();
      let deadline!: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error('Telemetry collector deadline exceeded'));
        }, 2000);
      });
      try {
        const collect = async () => {
          const response = await forward(target.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': req.is('application/json')
                ? 'application/json'
                : 'application/x-protobuf',
            },
            body: new Uint8Array(req.body as Buffer),
            signal: controller.signal,
            redirect: 'error',
          });
          // Collector details and browser credentials never cross this boundary.
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Collector rejected batch');
          }
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 1024 * 1024) {
                controller.abort();
                await reader.cancel();
                throw new Error('Collector response too large');
              }
              chunks.push(value);
            }
          }
          return { status: response.status, body: Buffer.concat(chunks) };
        };
        const result = await Promise.race([collect(), timeout]);
        res.type(req.is('application/json') ? 'application/json' : 'application/x-protobuf');
        res.status(result.status).send(result.body);
      } catch {
        res.sendStatus(502);
      } finally {
        clearTimeout(deadline);
      }
    },
  );
  const bodyError: ErrorRequestHandler = (error, _req, res, _next) => {
    res.sendStatus(error?.status === 413 ? 413 : 415);
  };
  router.use(bodyError);
  return router;
}
