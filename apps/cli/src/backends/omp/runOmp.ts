import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createOmpAcpRuntime } from '@/backends/omp/acp/runtime';
import { buildOmpApprovalModeForPermissionMode } from '@/backends/pi/acp/backend';

export async function runOmp(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'omp',
    backendDisplayName: 'Oh My Pi',
    uiLogPrefix: '[OMP]',
    providerName: 'Oh My Pi',
    waitingForCommandLabel: 'omp',
    agentMessageType: 'omp',
    supportsMcpServers: false,
    deliversSystemPromptAtSpawn: true,
    machineMetadata: initialMachineMetadata,
    loadTerminalDisplay: async () => (await import('@/backends/omp/ui/OmpTerminalDisplay')).OmpTerminalDisplay,
    // The approval mode is a launch argument, so a permission-mode change that maps to a different
    // one needs a new process (same contract as pi's launch-time tool allowlist).
    resolvePermissionModeQueueKey: (permissionMode) => buildOmpApprovalModeForPermissionMode(permissionMode),
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, getAbortSignal, memoryRecallGuidanceEnabled, processEnv, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) =>
      createOmpAcpRuntime({
        directory,
        machineId,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
        getSessionOpenAbortSignal: getAbortSignal,
        memoryRecallGuidanceEnabled,
        getPermissionMode,
        processEnv,
        pendingQueueDrainMaxPopPerWake,
        providerInputConsumer,
        credentials: opts.credentials,
        accountSettings: opts.accountSettingsContext?.settings ?? null,
      }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[omp] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
