import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import type { CliAuthSpec } from '@/backends/types';

// omp keeps its own credentials in its agent directory (login is interactive), so Happier can only
// observe provider API keys in the environment; absence of those is not proof of being logged out.
export const ompCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('omp', {
  detectAuthStatus: async () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      if ((process.env[name] ?? '').trim()) return { state: 'logged_in', method: 'api_key_env', source: 'env' };
    }
    return { state: 'unknown', reason: 'unsupported' };
  },
});
