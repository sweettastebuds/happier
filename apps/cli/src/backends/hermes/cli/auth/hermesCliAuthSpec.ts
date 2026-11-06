import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import type { CliAuthSpec } from '@/backends/types';

// Credentials live in the user's Hermes profile and are used by the gateway they run, not by Happier,
// so there is nothing for Happier to probe: reachability is checked at attach time instead.
export const hermesCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('hermes', {
  detectAuthStatus: async () => ({ state: 'unknown', reason: 'unsupported' }),
});
