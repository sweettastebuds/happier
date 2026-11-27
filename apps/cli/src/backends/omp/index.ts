import { AGENTS_CORE } from '@happier-dev/agents';

import type { AgentCatalogEntry } from '../types';
import { checklists } from './cli/checklists';

// omp is the pi RPC family's second agent: `getAcpBackendFactory` reuses the pi backend (no ACP is
// spoken) with the `omp` flavor. It has no connected services, bridge extension or direct sessions.
export const agent = {
  id: AGENTS_CORE.omp.id,
  cliSubcommand: AGENTS_CORE.omp.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/omp/cli/command')).handleOmpCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/omp/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/omp/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/omp/cli/auth/ompCliAuthSpec')).ompCliAuthSpec,
  vendorResumeSupport: AGENTS_CORE.omp.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createPiBackend } = await import('@/backends/pi/acp/backend');
    return (opts) => ({ backend: createPiBackend({ ...(opts as object), flavor: 'omp' } as Parameters<typeof createPiBackend>[0]) });
  },
  checklists,
} satisfies AgentCatalogEntry;
