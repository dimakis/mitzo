import { runPublicColdAdmission } from './fixtures/prepared-repository-native-public.js';
import { it } from 'vitest';

it(
  'keeps real cold prepared-checkout ownership through changed tools, early native events, ACK, a later command and a second cold generation',
  () => runPublicColdAdmission('tool-rollover'),
  420000,
);
