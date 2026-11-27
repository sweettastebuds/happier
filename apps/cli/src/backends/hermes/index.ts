import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.hermes.id,
  cliSubcommand: AGENTS_CORE.hermes.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/hermes/cli/command')).handleHermesCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/hermes/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/hermes/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/hermes/cli/auth/hermesCliAuthSpec')).hermesCliAuthSpec,
  vendorResumeSupport: AGENTS_CORE.hermes.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createHermesBackend } = await import('@/backends/hermes/gateway/createHermesBackend');
    return (opts) => ({ backend: createHermesBackend(opts as Parameters<typeof createHermesBackend>[0]) });
  },
  checklists,
} satisfies AgentCatalogEntry;
