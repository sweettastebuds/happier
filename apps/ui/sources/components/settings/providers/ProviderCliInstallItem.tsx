import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import type { CapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { Modal } from '@/modal';
import type { AgentId } from '@/agents/catalog/catalog';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { getProviderCliInstallGuideUrl } from '@happier-dev/agents';

export type ProviderCliInstallItemProps = Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: Extract<CapabilityId, `cli.${string}`>;
    providerId: AgentId;
    providerTitle: string;
    installed: boolean | null;
    managedInstalled?: boolean;
    installability?: CapabilityInstallability;
}>;

export function ProviderCliInstallItem(props: ProviderCliInstallItemProps) {
    const { theme } = useUnistyles();
    const { isInvoking: isInstalling, invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    const skipIfInstalled = props.managedInstalled !== true;
    const title = skipIfInstalled
        ? t('settingsProviders.cliInstaller.installTitle', { provider: props.providerTitle })
        : t('settingsProviders.cliInstaller.reinstallTitle', { provider: props.providerTitle });
    const installabilityKind = props.installability?.kind ?? 'unknown';
    const autoInstallAvailable = installabilityKind !== 'not-installable';
    const notManagedMessage = t('settingsProviders.cliInstaller.notManaged', {
        provider: props.providerTitle,
        url: getProviderCliInstallGuideUrl(props.providerId) ?? '',
    });
    const notManaged = props.installability?.kind === 'not-installable'
        && props.installability.code === 'install-not-available';
    const subtitle = notManaged
        ? notManagedMessage
        : !autoInstallAvailable
        ? t('settingsProviders.cliInstaller.autoInstallUnavailable')
        : skipIfInstalled
            ? t('settingsProviders.cliInstaller.installSubtitle')
            : t('settingsProviders.cliInstaller.reinstallSubtitle');

    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={<Icon name="download" size={29} color={theme.colors.text.secondary} />}
            showChevron={false}
            disabled={isInstalling || !props.machineId || !autoInstallAvailable || installabilityKind === 'checking'}
            rightElement={isInstalling ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : undefined}
            onPress={async () => {
                if (!props.machineId) {
                    Modal.alert(t('common.error'), t('settingsProviders.cliInstaller.noMachineSelected'));
                    return;
                }
                if (!autoInstallAvailable || installabilityKind === 'checking') {
                    return;
                }

                const confirmed = await Modal.confirm(
                    skipIfInstalled
                        ? t('settingsProviders.cliInstaller.confirmInstallTitle', { provider: props.providerTitle })
                        : t('settingsProviders.cliInstaller.confirmReinstallTitle', { provider: props.providerTitle }),
                    t('settingsProviders.cliInstaller.confirmBody', { provider: props.providerTitle }),
                    {
                        cancelText: t('common.cancel'),
                        confirmText: skipIfInstalled
                            ? t('settingsProviders.cliInstaller.confirmInstallConfirm')
                            : t('settingsProviders.cliInstaller.confirmReinstallConfirm'),
                        destructive: !skipIfInstalled,
                    },
                );
                if (!confirmed) {
                    return;
                }

                await invokeWithAlerts({
                    machineId: props.machineId,
                    request: {
                        id: props.capabilityId,
                        method: 'install',
                        params: {
                            skipIfInstalled,
                            allowVendorRecipeExecution: true,
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    serverId: props.serverId,
                    alerts: {
                        formatErrorMessage: (error) => error.code === 'install-not-available' ? notManagedMessage : error.message,
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) =>
                            reason === 'not-supported'
                                ? t('settingsProviders.cliInstaller.installNotSupported')
                                : t('settingsProviders.cliInstaller.installFailed'),
                        successMessage: t('settingsProviders.cliInstaller.installed'),
                        successWithLogPath: (logPath) => t('settingsProviders.cliInstaller.logPath', { logPath }),
                    },
                });
            }}
        />
    );
}
