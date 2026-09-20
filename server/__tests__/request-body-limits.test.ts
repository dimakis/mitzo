import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MAX_V2_CLIENT_PAYLOAD_BYTES } from '@mitzo/protocol';
import { createJsonRequestParser, JSON_REQUEST_BODY_LIMIT_BYTES } from '../request-body-limits.js';

describe('JSON request body limit', () => {
  it('shares the v2 transport envelope and accepts a REST payload above the legacy 10 MiB cap', async () => {
    expect(JSON_REQUEST_BODY_LIMIT_BYTES).toBe(MAX_V2_CLIENT_PAYLOAD_BYTES);

    const app = express();
    app.use(createJsonRequestParser());
    app.post('/send', (_req, res) => res.sendStatus(204));

    const overLegacyLimit = 'x'.repeat(10 * 1024 * 1024 + 1);
    await request(app)
      .post('/send')
      .send({ images: [{ data: overLegacyLimit }] })
      .expect(204);
  });
});
