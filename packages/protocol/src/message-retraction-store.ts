import type Database from 'better-sqlite3';

// Presence, including explicit JSON null, must match the canonical renderer's attribution fence.
export const ordinaryRetractionEventSql = (alias = '') => {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}seat_id IS NULL AND ${prefix}symposium_provenance IS NULL
    AND json_type(${prefix}payload,'$.seatId') IS NULL
    AND json_type(${prefix}payload,'$.symposiumProvenance') IS NULL`;
};

// Qualify the receipt's original ordinary identity using SQL scalars only. A
// display/source reader must not acquire deletion authority from foreign or
// malformed payloads, and must not hydrate private event data to check it.
export function validateOrdinaryRetractions(
  db: Database.Database,
  session: string,
  through: number,
  invalidReceipt: () => never = () => {
    throw Error('Stored provider retraction has no matching ordinary output identity');
  },
) {
  const invalid = db
    .prepare(
      `SELECT 1 FROM events r
    WHERE r.session_id=@session AND r.seq<=@through AND r.type='message_retracted'
    AND ${ordinaryRetractionEventSql('r')} AND (
      json_extract(r.payload,'$.sessionId') IS NOT @session OR
      json_type(r.payload,'$.messageId') IS NOT 'text' OR
      length(json_extract(r.payload,'$.messageId')) NOT BETWEEN 1 AND 2000 OR
      NOT EXISTS (SELECT 1 FROM events s WHERE s.session_id=r.session_id AND s.seq<r.seq
        AND s.type='message_start' AND ${ordinaryRetractionEventSql('s')}
        AND json_extract(s.payload,'$.messageId')=json_extract(r.payload,'$.messageId')) OR
      (json_type(r.payload,'$.toolId') IS NOT NULL AND (
        json_type(r.payload,'$.toolId') IS NOT 'text' OR
        length(json_extract(r.payload,'$.toolId')) NOT BETWEEN 1 AND 1000 OR
        NOT EXISTS (SELECT 1 FROM events t WHERE t.session_id=r.session_id AND t.seq<r.seq
          AND t.type='block_end' AND ${ordinaryRetractionEventSql('t')}
          AND json_extract(t.payload,'$.messageId')=json_extract(r.payload,'$.messageId')
          AND json_extract(t.payload,'$.blockType')='tool_use'
          AND json_extract(t.payload,'$.toolId')=json_extract(r.payload,'$.toolId'))))) LIMIT 1`,
    )
    .get({ session, through });
  if (invalid) invalidReceipt();
}
