import { runPublicColdAdmission } from './fixtures/prepared-repository-native-public.js';
import { it } from 'vitest';

it.each(['completed'] as const)(
  'reaches fresh qualified cold admission through the actual public owned entry after %s retirement and refuses a competing registered owner',
  runPublicColdAdmission,
  420000,
);
