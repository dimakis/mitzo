import { runPublicColdAdmission } from './fixtures/prepared-repository-native-public.js';
import { it } from 'vitest';

it(
  'cold resumes after a completed checkout continuation and a later interrupted explicit turn without replaying it',
  () => runPublicColdAdmission('followup-interrupted'),
  420000,
);
