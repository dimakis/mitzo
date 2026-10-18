import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HomeAssistantInventories,
  queryHomeAssistantInventory,
} from '../home-assistant-inventory.js';

const directories: string[] = [];
it('rejects oversized timestamps before they can expand the result metadata', () => {
  const data = snapshot();
  data.sections.devices.generated_at = '2026-10-18T12:00:00.' + '1'.repeat(17000) + 'Z';
  expect(() => queryHomeAssistantInventory(data, {})).toThrow();
});
it('matches the HA spoke portable contract fixture', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/ha-inventory-v1.json', import.meta.url), 'utf8'),
  );
  expect(
    queryHomeAssistantInventory(
      fixture.snapshot,
      { search: fixture.search },
      Date.parse(fixture.now),
    ),
  ).toEqual(fixture.expected);
});

it('caps result bytes while retaining the complete match count', () => {
  const data = snapshot();
  data.sections.devices.items = Array.from({ length: 50 }, (_, index) => ({
    ...data.sections.devices.items[0],
    id: String(index),
    model: 'Echo ' + 'x'.repeat(500),
  }));
  const result = queryHomeAssistantInventory(data, { search: 'echo', limit: 50 });
  expect(result.total_matches).toBe(50);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
});
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function snapshot() {
  const generated_at = '2026-10-18T12:00:00+00:00';
  return {
    schema_version: 1,
    sections: {
      devices: {
        generated_at,
        items: [
          {
            id: 'show',
            name: 'Shona',
            model: 'Echo Show 8',
            hw_version: '2nd Gen',
            area_id: 'kitchen',
            identifiers: ['private'],
          },
        ],
      },
      entities: { generated_at, items: [{ entity_id: 'media_player.shona', device_id: 'show' }] },
      areas: { generated_at, items: [{ area_id: 'kitchen', name: 'Kitchen' }] },
    },
  };
}
it('finds hardware hidden behind a friendly name, with entity and area links', () => {
  const result = queryHomeAssistantInventory(
    snapshot(),
    { search: 'echo' },
    Date.parse('2026-10-18T13:00:00Z'),
  );
  expect(result).toMatchObject({
    total_matches: 1,
    truncated: false,
    missing_sections: [],
    devices: [
      {
        name: 'Shona',
        model: 'Echo Show 8',
        hw_version: '2nd Gen',
        entity_ids: ['media_player.shona'],
        areas: ['Kitchen'],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(
    queryHomeAssistantInventory(snapshot(), { search: 'media_player.shona' }).total_matches,
  ).toBe(1);
});
it('exposes stale sections, missing joins and truncated results explicitly', () => {
  const data = snapshot();
  data.sections.devices.items.push({ ...data.sections.devices.items[0], id: 'second' });
  const result = queryHomeAssistantInventory(
    data,
    { search: 'echo', limit: 1 },
    Date.parse('2026-10-20T13:00:00Z'),
  );
  expect(result).toMatchObject({
    total_matches: 2,
    truncated: true,
    freshness: { devices: { stale: true } },
  });
  expect(() =>
    queryHomeAssistantInventory({ schema_version: 1, sections: {} }, { search: 'echo' }),
  ).toThrow();
  expect(() => queryHomeAssistantInventory(snapshot(), { limit: 51 })).toThrow();
});
it('reads only explicitly bound private regular files and rejects symlinks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-inventory-'));
  directories.push(directory);
  const file = join(directory, 'inventory.json');
  writeFileSync(file, JSON.stringify(snapshot()), { mode: 0o600 });
  const inventories = new HomeAssistantInventories({ ha: file });
  expect(inventories.has('ha')).toBe(true);
  expect((await inventories.read('ha', { search: 'echo' })).total_matches).toBe(1);
  await expect(inventories.read('other', {})).rejects.toMatchObject({
    code: 'inventory_unavailable',
  });
  const link = join(directory, 'link');
  symlinkSync(file, link);
  await expect(new HomeAssistantInventories({ ha: link }).read('ha', {})).rejects.toMatchObject({
    code: 'inventory_unavailable',
  });
  chmodSync(file, 0o644);
  await expect(inventories.read('ha', {})).rejects.toMatchObject({ code: 'inventory_unavailable' });
});
