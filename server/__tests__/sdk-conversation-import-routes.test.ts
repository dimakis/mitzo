import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSdkConversationImportRouter } from '../sdk-conversation-import-routes.js';

describe('explicit SDK conversation import', () => {
  it('lists candidates without importing and imports only the explicitly selected ID', async () => {
    const id = 'f619d45a-c704-4a3b-a169-5331c4676da4';
    const list = vi.fn().mockResolvedValue([{ id, summary: 'CLI conversation' }]);
    const adopt = vi.fn().mockResolvedValue({ sessionId: id });
    const app = express()
      .use(express.json())
      .use(createSdkConversationImportRouter({ list, adopt }));
    expect((await request(app).get('/importable')).body.candidates).toHaveLength(1);
    expect(adopt).not.toHaveBeenCalled();
    expect((await request(app).post('/import').send({ sessionId: id })).status).toBe(200);
    expect(adopt).toHaveBeenCalledWith(id);
    expect(
      (await request(app).post('/import').send({ sessionId: id, cwd: '/arbitrary' })).status,
    ).toBe(400);
    adopt.mockResolvedValueOnce({ sessionId: 'different' });
    expect((await request(app).post('/import').send({ sessionId: id })).status).toBe(500);
    adopt.mockResolvedValue(null);
    expect((await request(app).post('/import').send({ sessionId: id })).status).toBe(404);
  });
  it('does not report import success when admission fails', async () => {
    const app = express()
      .use(express.json())
      .use(
        createSdkConversationImportRouter({
          list: async () => [],
          adopt: async () => {
            throw new Error('Storage failure');
          },
        }),
      );
    expect(
      (
        await request(app)
          .post('/import')
          .send({ sessionId: 'f619d45a-c704-4a3b-a169-5331c4676da4' })
      ).status,
    ).toBe(500);
  });
});
