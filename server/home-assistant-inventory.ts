import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ConnectionRequestError } from './connection-request-error.js';

const text = z.string().max(512);
const optional = text.nullable().optional();
const device = z.object({
  id: text.min(1),
  name: optional,
  name_by_user: optional,
  manufacturer: optional,
  model: optional,
  model_id: optional,
  hw_version: optional,
  sw_version: optional,
  area_id: optional,
});
const entity = z.object({
  entity_id: text.min(1),
  name: optional,
  original_name: optional,
  device_id: optional,
  area_id: optional,
});
const area = z.object({ area_id: text.min(1), name: optional });
const generatedAt = z.string().datetime({ offset: true });
const section = <T extends z.ZodType>(item: T) =>
  z.object({ generated_at: generatedAt, items: z.array(item).max(20000) });
const snapshot = z
  .object({
    schema_version: z.literal(1),
    sections: z
      .object({
        devices: section(device),
        entities: section(entity).optional(),
        areas: section(area).optional(),
      })
      .strict(),
  })
  .strict();
export const HomeAssistantInventoryQuerySchema = z
  .object({
    search: z.string().max(256).default(''),
    limit: z.number().int().min(1).max(50).default(10),
    maxAgeHours: z.number().min(0).max(8760).default(24),
  })
  .strict();
export type HomeAssistantInventoryQuery = z.input<typeof HomeAssistantInventoryQuerySchema>;
const kinds = ['devices', 'entities', 'areas'] as const;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;

/** Version 1 is owned by the HA spoke's lib/inventory.py; do not ingest raw states. */
export function queryHomeAssistantInventory(
  input: unknown,
  query: HomeAssistantInventoryQuery,
  now = Date.now(),
) {
  const data = snapshot.parse(input);
  const options = HomeAssistantInventoryQuerySchema.parse(query);
  for (const kind of kinds) {
    const items = data.sections[kind]?.items;
    if (!items) continue;
    const ids = items.map((item) =>
      'id' in item ? item.id : 'entity_id' in item ? item.entity_id : item.area_id,
    );
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate registry record');
  }
  const freshness = Object.fromEntries(
    kinds.flatMap((kind) => {
      const value = data.sections[kind];
      if (!value) return [];
      const age = (now - Date.parse(value.generated_at)) / 1000;
      return [
        [
          kind,
          {
            generated_at: value.generated_at,
            age_seconds: Math.max(0, Math.floor(age)),
            stale: age < -300 || age > options.maxAgeHours * 3600,
          },
        ],
      ];
    }),
  );
  const areas = new Map(data.sections.areas?.items.map((item) => [item.area_id, item.name]));
  const entities = new Map<string, z.infer<typeof entity>[]>();
  for (const item of data.sections.entities?.items ?? []) {
    if (!item.device_id) continue;
    const related = entities.get(item.device_id) ?? [];
    related.push(item);
    entities.set(item.device_id, related);
  }
  const needle = options.search.trim().toLowerCase();
  const matches = [...data.sections.devices.items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((item) => {
      const related = entities.get(item.id) ?? [];
      const names = [
        ...new Set(
          [item.area_id, ...related.map((e) => e.area_id)].flatMap((id) => {
            const name = id ? areas.get(id) : null;
            return name ? [name] : [];
          }),
        ),
      ].sort();
      const searchable = [
        ...Object.values(item),
        ...related.flatMap((e) => Object.values(e)),
        ...names,
      ]
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(needle)) return [];
      const ids = related.map((e) => e.entity_id).sort();
      return [
        {
          ...item,
          areas: names.slice(0, 10),
          areas_truncated: names.length > 10,
          entity_ids: ids.slice(0, 20),
          entity_count: ids.length,
          entities_truncated: ids.length > 20,
        },
      ];
    });
  const result = {
    status: 'ok',
    schema_version: 1,
    source: 'ha-spoke-inventory',
    freshness,
    missing_sections: kinds.filter((kind) => !data.sections[kind]),
    total_matches: matches.length,
    truncated: false,
    devices: [] as typeof matches,
  };
  for (const item of matches.slice(0, options.limit)) {
    result.devices.push(item);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES - 32) {
      result.devices.pop();
      break;
    }
  }
  result.truncated = result.devices.length < matches.length;
  return result;
}

/** Paths are host configuration, never tool input. No credential access or shell execution. */
export class HomeAssistantInventories {
  constructor(private files: Readonly<Record<string, string>>) {
    if (
      Object.keys(files).length > 64 ||
      Object.entries(files).some(([id, path]) => !id || id.length > 128 || !isAbsolute(path))
    )
      throw new Error('Invalid HA inventory configuration');
    this.files = Object.freeze({ ...files });
  }
  has(id: string) {
    return Object.hasOwn(this.files, id);
  }
  async read(id: string, query: HomeAssistantInventoryQuery) {
    let file;
    try {
      if (!this.has(id)) throw new Error('No binding');
      file = await open(
        this.files[id],
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > MAX_FILE_BYTES ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error('Invalid inventory file');
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, stat.size + 1));
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > stat.size || size > MAX_FILE_BYTES)
        throw new Error('Inventory changed while reading');
      return queryHomeAssistantInventory(
        JSON.parse(buffer.subarray(0, size).toString('utf8')),
        query,
      );
    } catch {
      throw new ConnectionRequestError('inventory_unavailable');
    } finally {
      await file?.close();
    }
  }
}
