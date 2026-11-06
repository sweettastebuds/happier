import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const HERMES_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'hermes',
    title: { key: 'settingsProviders.plugins.hermes.title' },
    icon: { ionName: 'flash-outline', color: { kind: 'theme', token: 'blue' } },
});
