import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const detect = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', async () => ({
    ...(await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
    Octicons: () => null,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// Network boundary: the machine RPC behind capability detection.
vi.mock('@/sync/ops', () => ({ machineCapabilitiesDetect: detect }));

// Lightweight list primitives that expose title/onPress, so the test reads the selection contract.
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { title: string; testID?: string }) => React.createElement('Item', { ...props, testID: `item:${props.title}` }),
}));

function profilesResponse(profiles: unknown) {
    return {
        supported: true,
        response: { protocolVersion: 1, results: { 'cli.hermes': { ok: true, checkedAt: 1, data: { available: true, profiles } } } },
    };
}

describe('HermesProfileSelectionContent', () => {
    beforeEach(() => detect.mockReset());

    it('lists the machine profiles and selects one, closing the popover', async () => {
        detect.mockResolvedValue(profilesResponse([{ name: 'default', active: true }, { name: 'work', active: false }]));
        const { HermesProfileSelectionContent } = await import('./HermesProfileChip');
        const { renderScreen } = await import('@/dev/testkit');
        const onSelect = vi.fn();
        const requestClose = vi.fn();

        const screen = await renderScreen(React.createElement(HermesProfileSelectionContent, {
            profile: null, machineId: 'm1', serverId: 's1', onSelect, requestClose,
        }));
        await vi.waitFor(() => expect(screen.findByTestId('item:work')).toBeTruthy());

        expect(detect).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ requests: [{ id: 'cli.hermes', params: { includeProfiles: true } }] }),
            expect.objectContaining({ serverId: 's1' }),
        );
        screen.pressByTestId('item:work');
        expect(onSelect).toHaveBeenCalledWith('work');
        expect(requestClose).toHaveBeenCalled();

        screen.pressByTestId('item:agentInput.hermesProfileChip.active');
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it('says so when the profiles cannot be listed', async () => {
        detect.mockResolvedValue({ supported: false, reason: 'error' });
        const { HermesProfileSelectionContent } = await import('./HermesProfileChip');
        const { renderScreen } = await import('@/dev/testkit');

        const screen = await renderScreen(React.createElement(HermesProfileSelectionContent, {
            profile: null, machineId: 'm1', serverId: null, onSelect: vi.fn(), requestClose: vi.fn(),
        }));
        await vi.waitFor(() => expect(screen.findByTestId('item:agentInput.hermesProfileChip.error')).toBeTruthy());
    });
});

describe('createHermesProfileChip', () => {
    it('labels the chip with the chosen profile and opens the profile list as a provider option', async () => {
        const { createHermesProfileChip } = await import('./HermesProfileChip');
        const chip = createHermesProfileChip({ profile: 'work', machineId: 'm1', serverId: 's1', setProfile: vi.fn() });
        expect(chip.controlId).toBe('providerOption');
        expect(chip.collapsedContentPopover?.label).toBe('work');

        const unset = createHermesProfileChip({ profile: null, machineId: 'm1', serverId: 's1', setProfile: vi.fn() });
        expect(unset.collapsedContentPopover?.label).toBe('agentInput.hermesProfileChip.active');
        expect(unset.stabilityKey).not.toBe(chip.stabilityKey);
    });
});
