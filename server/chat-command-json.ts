import express, { type Express, type RequestHandler } from 'express';
import { CHAT_MAX_COMMAND_BYTES } from '@mitzo/protocol';

/** Install before the general JSON parser. Large command bodies require authentication. */
export function installChatCommandJson(
  app: Express,
  authenticate: RequestHandler,
  ...additionalAuthentication: RequestHandler[]
): void {
  const entryPaths = [
    '/api/chat/runtime',
    '/api/chat/local-codex',
    '/api/ordinary/workspaces/commands',
  ];
  const paths = entryPaths.flatMap((prefix) =>
    ['send', 'first', 'continue', 'send/receipt', 'first/receipt', 'continue/receipt'].map(
      (suffix) => `${prefix}/${suffix}`,
    ),
  );
  paths.push('/api/chat/send', '/api/chat/interrupt');
  const parse = express.json({ limit: CHAT_MAX_COMMAND_BYTES });
  app.post(paths, authenticate, ...additionalAuthentication, (req, res, next) => {
    parse(req, res, (error?: { type?: string }) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({
          ok: false,
          error:
            'Message exceeds the 192 MiB encoded request limit. Use up to 100 images or PDF pages (64 MiB combined) and 8 MiB of text.',
        });
        return;
      }
      next(error);
    });
  });
}
