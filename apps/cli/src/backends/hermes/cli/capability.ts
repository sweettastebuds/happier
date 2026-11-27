import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { resolveProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

import { runHermesCommand } from '../gateway/runHermesCommand';
import { listHermesProfiles, type HermesProfileListEntry } from './profileList';

async function listProfilesFromInstalledHermes(): Promise<HermesProfileListEntry[]> {
  const launch = resolveProviderCliLaunchSpec('hermes');
  if (!launch) throw new Error('The Hermes CLI could not be resolved.');
  return await listHermesProfiles({ launch, env: process.env, run: runHermesCommand });
}

/**
 * `cli.hermes`. With `includeProfiles` it also reports the machine's Hermes profiles, the choices for
 * the new-session profile selector (a session's profile is fixed when it starts).
 */
export function createHermesCliCapability(deps: Readonly<{
  listProfiles: () => Promise<readonly HermesProfileListEntry[]>;
}>): Capability {
  return {
    descriptor: { id: 'cli.hermes', kind: 'cli', title: 'Hermes CLI' },
    detect: async ({ request, context }) => {
      const data = buildCliCapabilityData({ request, entry: context.cliSnapshot?.clis?.hermes });
      if (!data.available || (request.params ?? {}).includeProfiles !== true) return data;
      try {
        return { ...data, profiles: await deps.listProfiles() };
      } catch (error) {
        return { ...data, profilesError: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export const cliCapability: Capability = createHermesCliCapability({ listProfiles: listProfilesFromInstalledHermes });
