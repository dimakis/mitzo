import { runPublicColdAdmission } from './fixtures/prepared-repository-native-public.js';
import { it } from 'vitest';

it(
  'cancels an undispatched prepared primary, then continues new explicit work after an acknowledged rollover turn is interrupted',
  () => runPublicColdAdmission('tool-rollover-queued'),
  420000,
);
