import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const HERMES_CORE: AgentCoreConfig = {
    id: 'hermes',
    displayNameKey: 'agentInput.agent.hermes',
    subtitleKey: 'profiles.aiBackend.hermesSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'hermes' }),
    uiConnectedService: { serviceId: null, label: 'Hermes Agent', connectRoute: null },
    flavorAliases: ['hermes', 'hermes-agent'],
    cli: buildCatalogProviderCliUiConfig('hermes'),
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    sessionModes: { kind: getAgentSessionModesKind('hermes') },
    model: getAgentModelConfig('hermes'),
    resume: buildAgentResumeUiConfig({
        agentId: 'hermes',
        uiVendorResumeIdLabelKey: 'sessionInfo.hermesSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.hermesSessionIdCopied',
    }),
    toolRendering: { hideUnknownToolsByDefault: true },
    tools: buildAgentToolsUiConfig({ agentId: 'hermes' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'hermes' }),
    ui: { agentPickerIconName: 'flash-outline', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
};
