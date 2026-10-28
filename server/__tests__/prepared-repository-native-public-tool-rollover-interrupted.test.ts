import { runPublicColdAdmission } from './fixtures/prepared-repository-native-public.js';
import { it } from 'vitest';

it(
  'retains acknowledged interrupted-primary evidence across cold tool rollover and later generations, then fences revoked ownership',
  () => runPublicColdAdmission('tool-rollover-interrupted'),
  420000,
);
