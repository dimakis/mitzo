import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/** Synthetic external service only. Owned health, proxy, UI and media codecs
 * remain real. Silence is valid PCM, and recording bytes come from Chromium's
 * real MediaRecorder over a synthetic MediaStream, never a hardware device. */
export async function createFakeVoiceEffects() {
  const http: Array<{ path: string; body: unknown }> = [];
  const recordings: Array<{ format: unknown; bytes: number; ended: boolean; transcript: string }> =
    [];
  let transcript = '';
  const wav = Buffer.alloc(44 + 16_000 * 2 * 5);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    http.push({ path: req.url!, body });
    if (req.url === '/v1/synthesize') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health')
      res.end(JSON.stringify({ status: 'ready', models: { stt: true, tts: true } }));
    else if (req.url === '/v1/voices')
      res.end(
        JSON.stringify({
          voices: [
            {
              id: 'synthetic-silence',
              name: 'Synthetic silence',
              language: 'en',
              gender: 'neutral',
            },
          ],
        }),
      );
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Unexpected synthetic external request' }));
    }
  });
  const ws = new WebSocketServer({ server, path: '/v1/transcribe/stream' });
  ws.on('connection', (socket) => {
    const row = { format: null as unknown, bytes: 0, ended: false, transcript };
    recordings.push(row);
    socket.on('message', (data, binary) => {
      if (binary) row.bytes += (data as Buffer).length;
      else if (data.toString() === 'END') {
        row.ended = true;
        socket.send(JSON.stringify({ type: 'final', text: row.transcript }));
      } else row.format = JSON.parse(data.toString());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || [3100, 3101, 3190].includes(address.port))
    throw Error('Private fake effect listener required');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    http,
    recordings,
    setTranscript(value: string) {
      transcript = value;
    },
    async close() {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
