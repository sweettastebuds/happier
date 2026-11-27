import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { runOmp } from '@/backends/omp/runOmp';

export async function handleOmpCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runOmp,
    agentIdForAccountSettings: 'omp',
  });
}
