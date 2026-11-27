import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { runHermes } from '@/backends/hermes/runHermes';

export async function handleHermesCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runHermes,
    agentIdForAccountSettings: 'hermes',
  });
}
