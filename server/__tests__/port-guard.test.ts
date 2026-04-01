import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { checkPort } from '../port-check.js';

let dummyServer: Server | null = null;

afterEach(() => {
  if (dummyServer) {
    dummyServer.close();
    dummyServer = null;
  }
});

describe('checkPort', () => {
  it('returns false when port is free', async () => {
    const free = await checkPort(19999);
    expect(free).toBe(false);
  });

  it('returns true when port is occupied', async () => {
    dummyServer = createServer();
    await new Promise<void>((resolve) => dummyServer!.listen(19998, resolve));

    const occupied = await checkPort(19998);
    expect(occupied).toBe(true);
  });
});
