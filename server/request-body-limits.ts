import express from 'express';
import { MAX_V2_CLIENT_PAYLOAD_BYTES } from '@mitzo/protocol';

// REST chat sends use the same v2 envelope as WebSocket sends. In particular,
// a valid 20 MiB decoded image aggregate occupies over 26 MiB as base64 before
// JSON framing. Keep the parser tied to the WebSocket frame ceiling rather than
// maintaining a separate, drifting byte budget.
export const JSON_REQUEST_BODY_LIMIT_BYTES = MAX_V2_CLIENT_PAYLOAD_BYTES;

export function createJsonRequestParser(): express.RequestHandler {
  return express.json({ limit: JSON_REQUEST_BODY_LIMIT_BYTES });
}
