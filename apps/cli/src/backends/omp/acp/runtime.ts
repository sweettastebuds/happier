import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { Credentials } from '@/persistence';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { PiBackendOptions } from '@/backends/pi/acp/backend';

export function createOmpAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getSessionOpenAbortSignal?: () => AbortSignal | undefined;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  processEnv?: NodeJS.ProcessEnv;
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
  credentials: Credentials;
  accountSettings?: Record<string, unknown> | null;
}) {
  return createCatalogProviderAcpRuntime<PiBackendOptions>({
    provider: 'omp',
    loggerLabel: 'OmpACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: { kind: 'manifest-metadata' },
    onThinkingChange: params.onThinkingChange,
    getSessionOpenAbortSignal: params.getSessionOpenAbortSignal,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    processEnv: params.processEnv ?? process.env,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    inFlightSteer: { enabled: true },
    // omp has no Happier tools bridge; the Happier prompt is delivered at spawn through
    // `--append-system-prompt` (the backend turns this text into a protected temp file).
    resolveBackendOptionsBeforeSpawn: async ({ session }) => {
      const text = await resolveEffectiveCodingPromptText({
        credentials: params.credentials,
        settings: params.accountSettings ?? null,
        profileId: session.getMetadataSnapshot()?.profileId ?? null,
        sessionMetadata: session.getMetadataSnapshot(),
        providerId: 'omp',
        executionRunsFeatureEnabled: resolveCliFeatureDecision({
          featureId: 'execution.runs',
          env: process.env,
        }).state === 'enabled',
        baseOverride: null,
        memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled === true,
      });
      return { appendSystemPromptText: typeof text === 'string' && text.trim() ? text : undefined };
    },
  });
}
