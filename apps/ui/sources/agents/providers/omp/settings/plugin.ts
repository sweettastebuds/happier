import { createNoopProviderSettingsPlugin } from '@/agents/providers/shared/createNoopProviderSettingsPlugin';

export const OMP_PROVIDER_SETTINGS_PLUGIN = createNoopProviderSettingsPlugin({
    providerId: 'omp',
    title: { key: 'settingsProviders.plugins.omp.title' },
    icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'orange' } },
});
