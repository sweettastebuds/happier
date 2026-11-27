import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';

export const cliCapability: Capability = {
  descriptor: { id: 'cli.omp', kind: 'cli', title: 'Oh My Pi CLI' },
  detect: async ({ request, context }) => {
    const entry = context.cliSnapshot?.clis?.omp;
    return buildCliCapabilityData({ request, entry });
  },
};
