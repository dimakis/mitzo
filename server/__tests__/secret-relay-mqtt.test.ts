import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import {
  MqttRelayTargetSchema,
  sendMqttRelayTarget,
  validateMqttRelayTarget,
} from '../secret-relay-mqtt.js';
const target = {
  adapter: 'mqtt' as const,
  broker: 'mqtts://broker.example:8883',
  username: 'device',
  operation: 'publish' as const,
  topic: 'home/device/set',
  payload: 'on',
  retain: false,
  allowPrivateNetwork: false,
};
function fixture(replies: Buffer[]) {
  const packets: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      packets.push(Buffer.from(chunk));
      done();
      const response = replies.shift();
      if (response)
        queueMicrotask(() => {
          stream.push(response.subarray(0, 1));
          stream.push(response.subarray(1));
        });
    },
  });
  return { packets, stream, open: vi.fn(async () => stream) };
}
it('sends private CONNECT and one QoS1 PUBLISH, then requires matching PUBACK', async () => {
  const f = fixture([Buffer.from([0x20, 2, 0, 0]), Buffer.from([0x40, 2, 0, 1])]);
  const dispatched = vi.fn();
  expect(
    await sendMqttRelayTarget(
      target,
      'private-password',
      AbortSignal.timeout(1000),
      () => {},
      dispatched,
      undefined,
      f.open,
    ),
  ).toEqual({ acknowledgement: 'puback' });
  expect(dispatched).toHaveBeenCalledOnce();
  expect(f.packets[0][0]).toBe(0x10);
  let payload = 1;
  while ((f.packets[0][payload++] & 0x80) !== 0) {}
  payload += 10;
  const clientLength = f.packets[0].readUInt16BE(payload);
  const clientId = f.packets[0].subarray(payload + 2, payload + 2 + clientLength).toString();
  expect(clientLength).toBeLessThanOrEqual(23);
  expect(clientId).toMatch(/^[a-zA-Z0-9]+$/);
  expect(f.packets[0].includes(Buffer.from('private-password'))).toBe(true);
  expect(f.packets[1][0]).toBe(0x32);
  expect(f.packets[1].includes(Buffer.from('private-password'))).toBe(false);
  expect(f.open).toHaveBeenCalledOnce();
});
it('verifies authentication without publishing for connect operations', async () => {
  const f = fixture([Buffer.from([0x20, 2, 0, 0])]);
  const base = {
    adapter: target.adapter,
    broker: target.broker,
    username: target.username,
    allowPrivateNetwork: target.allowPrivateNetwork,
  };
  expect(
    await sendMqttRelayTarget(
      { ...base, operation: 'connect' },
      'fixture',
      AbortSignal.timeout(1000),
      () => {},
      () => {},
      undefined,
      f.open,
    ),
  ).toEqual({ acknowledgement: 'connack' });
  expect(f.packets.map((b) => b[0])).toEqual([0x10, 0xe0]);
});
it.each([
  Buffer.from([0x20, 2, 0, 5]),
  Buffer.from([0x20, 2, 1, 0]),
  Buffer.from([0x20, 2, 0, 0, 0x40, 2, 0, 2]),
])(
  'rejects refusal, invalid clean-session response and mismatched acknowledgements without retry',
  async (response) => {
    const f = fixture([response]);
    await expect(
      sendMqttRelayTarget(
        target,
        'fixture',
        AbortSignal.timeout(30),
        () => {},
        () => {},
        undefined,
        f.open,
      ),
    ).rejects.toThrow('MQTT operation unconfirmed');
    expect(f.open).toHaveBeenCalledOnce();
  },
);
it('rechecks authority before credentials and publish and destroys on cancellation', async () => {
  const f = fixture([Buffer.from([0x20, 2, 0, 0])]);
  let permitted = true;
  const check = () => {
    if (!permitted) throw new Error('revoked');
  };
  const current = vi.fn(async () => {
    if (current.mock.calls.length === 3) permitted = false;
  });
  await expect(
    sendMqttRelayTarget(
      target,
      'fixture',
      AbortSignal.timeout(100),
      check,
      () => {},
      current,
      f.open,
    ),
  ).rejects.toThrow();
  expect(f.packets.some((b) => b[0] === 0x32)).toBe(false);
  expect(f.stream.destroyed).toBe(true);
});
it('permits only reviewed broker origins and exact topics; cleartext requires separate explicit LAN consent', () => {
  expect(validateMqttRelayTarget(target, false).hostname).toBe('broker.example');
  for (const broker of [
    'mqtts://user:pass@broker.example:8883',
    'mqtts://broker.example:8883/path',
    'mqtts://127.0.0.1:8883',
    'mqtts://169.254.169.254:8883',
    'mqtt://8.8.8.8:1883',
    'mqtt://broker.example:1883',
  ])
    expect(() => validateMqttRelayTarget({ ...target, broker }, true)).toThrow();
  expect(() =>
    validateMqttRelayTarget({ ...target, broker: 'mqtt://192.168.1.115:1883' }, false),
  ).toThrow();
  expect(
    validateMqttRelayTarget({ ...target, broker: 'mqtt://192.168.1.115:1883' }, true).protocol,
  ).toBe('mqtt:');
  for (const topic of ['home/#', 'home/+', '', 'a\u0000b'])
    expect(MqttRelayTargetSchema.safeParse({ ...target, topic }).success).toBe(false);
});
