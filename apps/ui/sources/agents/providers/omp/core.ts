import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const OMP_CORE: AgentCoreConfig = {
    id: 'omp',
    displayNameKey: 'agentInput.agent.omp',
    subtitleKey: 'profiles.aiBackend.ompSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'omp' }),
    uiConnectedService: { serviceId: null, label: 'Oh My Pi', connectRoute: null },
    flavorAliases: ['omp', 'oh-my-pi'],
    cli: buildCatalogProviderCliUiConfig('omp'),
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    sessionModes: { kind: getAgentSessionModesKind('omp') },
    model: getAgentModelConfig('omp'),
    resume: buildAgentResumeUiConfig({
        agentId: 'omp',
        uiVendorResumeIdLabelKey: 'sessionInfo.ompSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.ompSessionIdCopied',
    }),
    toolRendering: { hideUnknownToolsByDefault: true },
    tools: buildAgentToolsUiConfig({ agentId: 'omp' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'omp' }),
    ui: { agentPickerIconName: 'code-slash-outline', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
};
