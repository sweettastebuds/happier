import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { machineCapabilitiesDetect } from '@/sync/ops';
import { t } from '@/text';

import { readHermesProfilesFromCapability, type HermesProfilesReadResult } from './profile';

const CHIP_KEY = 'hermes-profile';
// `hermes profile list` starts a Python process, which is slower than the default capability probe.
const PROFILE_LIST_TIMEOUT_MS = 10_000;

type ProfilesState = Readonly<{ status: 'loading' }> | HermesProfilesReadResult;

function useHermesProfiles(machineId: string | null, serverId: string | null): ProfilesState {
    const [state, setState] = React.useState<ProfilesState>({ status: 'loading' });
    React.useEffect(() => {
        if (!machineId) {
            setState({ status: 'error' });
            return;
        }
        let cancelled = false;
        setState({ status: 'loading' });
        void machineCapabilitiesDetect(
            machineId,
            { requests: [{ id: 'cli.hermes', params: { includeProfiles: true } }], bypassCache: true },
            { timeoutMs: PROFILE_LIST_TIMEOUT_MS, serverId },
        ).then((result) => {
            if (cancelled) return;
            setState(result.supported
                ? readHermesProfilesFromCapability(result.response.results['cli.hermes'])
                : { status: 'error' });
        });
        return () => { cancelled = true; };
    }, [machineId, serverId]);
    return state;
}

export function HermesProfileSelectionContent(props: Readonly<{
    profile: string | null;
    machineId: string | null;
    serverId: string | null;
    onSelect: (profile: string | null) => void;
    requestClose: () => void;
}>) {
    const profiles = useHermesProfiles(props.machineId, props.serverId);
    const choose = (next: string | null) => {
        props.onSelect(next);
        props.requestClose();
    };
    const profileList = profiles.status === 'ready' ? profiles.profiles : [];

    return (
        <ItemGroup title={t('agentInput.hermesProfileChip.title')} footer={t('agentInput.hermesProfileChip.footer')}>
            <Item
                title={t('agentInput.hermesProfileChip.active')}
                subtitle={t('agentInput.hermesProfileChip.activeSubtitle')}
                selected={props.profile === null}
                onPress={() => choose(null)}
                showChevron={false}
            />
            {profileList.map((entry) => (
                <Item
                    key={entry.name}
                    title={entry.name}
                    subtitle={entry.active ? t('agentInput.hermesProfileChip.currentlyActive') : undefined}
                    selected={props.profile === entry.name}
                    onPress={() => choose(entry.name)}
                    showChevron={false}
                />
            ))}
            {profiles.status === 'loading' ? (
                <Item title={t('agentInput.hermesProfileChip.loading')} showChevron={false} />
            ) : null}
            {profiles.status === 'error' ? (
                <Item title={t('agentInput.hermesProfileChip.error')} showChevron={false} />
            ) : null}
            {profiles.status === 'unavailable' ? (
                <Item title={t('agentInput.hermesProfileChip.notInstalled')} showChevron={false} />
            ) : null}
        </ItemGroup>
    );
}

export function createHermesProfileChip(params: Readonly<{
    profile: string | null;
    machineId: string | null;
    serverId: string | null;
    setProfile: (profile: string | null) => void;
}>): AgentInputExtraActionChip {
    const label = params.profile ?? t('agentInput.hermesProfileChip.active');
    return {
        key: CHIP_KEY,
        controlId: 'providerOption',
        stabilityKey: `${params.machineId ?? ''}|${params.serverId ?? ''}|${params.profile ?? ''}`,
        collapsedContentPopover: {
            title: t('agentInput.hermesProfileChip.title'),
            label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="user-circle" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: ({ requestClose }) => (
                <HermesProfileSelectionContent
                    profile={params.profile}
                    machineId={params.machineId}
                    serverId={params.serverId}
                    onSelect={params.setProfile}
                    requestClose={requestClose}
                />
            ),
            maxHeightCap: 420,
            scrollEnabled: true,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                onPress={() => toggleCollapsedPopover?.(CHIP_KEY)}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
                accessibilityRole="button"
                accessibilityLabel={t('agentInput.hermesProfileChip.title')}
            >
                {normalizeNodeForView(
                    <Icon name="user-circle" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />,
                )}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {label}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
