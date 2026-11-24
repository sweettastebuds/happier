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

// Presentation boundaries for the real Item/ItemGroup.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

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
        await vi.waitFor(() => expect(screen.findByTestId('hermes-profile-option:work')).toBeTruthy());

        expect(detect).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ requests: [{ id: 'cli.hermes', params: { includeProfiles: true } }] }),
            expect.objectContaining({ serverId: 's1' }),
        );
        screen.pressByTestId('hermes-profile-option:work');
        expect(onSelect).toHaveBeenCalledWith('work');
        expect(requestClose).toHaveBeenCalled();

        screen.pressByTestId('hermes-profile-option:active');
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it('says so when the profiles cannot be listed', async () => {
        detect.mockResolvedValue({ supported: false, reason: 'error' });
        const { HermesProfileSelectionContent } = await import('./HermesProfileChip');
        const { renderScreen } = await import('@/dev/testkit');

        const screen = await renderScreen(React.createElement(HermesProfileSelectionContent, {
            profile: null, machineId: 'm1', serverId: null, onSelect: vi.fn(), requestClose: vi.fn(),
        }));
        await vi.waitFor(() => expect(screen.findByTestId('hermes-profile-error')).toBeTruthy());
    });
});

describe('HermesProfileSelectionContent failure', () => {
    it('shows the error state when the capability request rejects instead of loading forever', async () => {
        detect.mockRejectedValue(new Error('rpc dropped'));
        const { HermesProfileSelectionContent } = await import('./HermesProfileChip');
        const { renderScreen } = await import('@/dev/testkit');

        const screen = await renderScreen(React.createElement(HermesProfileSelectionContent, {
            profile: null, machineId: 'm1', serverId: null, onSelect: vi.fn(), requestClose: vi.fn(),
        }));
        await vi.waitFor(() => expect(screen.findByTestId('hermes-profile-error')).toBeTruthy());
        expect(screen.findByTestId('hermes-profile-loading')).toBeNull();
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
