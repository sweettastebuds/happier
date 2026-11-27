import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useProviderCliInstallQueue } from './useProviderCliInstallQueue';

const capabilitiesState = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...original,
        machineCapabilitiesInvoke: capabilitiesState.invoke,
    };
});

describe('useProviderCliInstallQueue', () => {
    beforeEach(() => {
        capabilitiesState.invoke.mockReset();
    });

    it('runs installs sequentially and continues after failures', async () => {
        capabilitiesState.invoke
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } })
            .mockResolvedValueOnce({ supported: true, response: { ok: false, error: { message: 'boom' }, logPath: '/tmp/claude.log' } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useProviderCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            providerIds: ['codex', 'claude', 'gemini'],
            providerDetectKeys: { codex: 'codex', claude: 'claude', gemini: 'gemini' },
            installedByProviderId: { codex: false, claude: false, gemini: false },
        }));

        let summary: { installedProviderIds: string[]; failedProviderIds: string[] } | null = null;
        await act(async () => {
            summary = await hook.getCurrent().start();
        });

        expect(summary).toEqual({
            installedProviderIds: ['codex', 'gemini'],
            failedProviderIds: ['claude'],
        });
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(3);
        expect(capabilitiesState.invoke.mock.calls.map((call) => call[1]?.id)).toEqual(['cli.codex', 'cli.claude', 'cli.gemini']);

        expect(hook.getCurrent().resolveStatus('codex').status).toBe('installed');
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('failed');
        expect(hook.getCurrent().resolveStatus('gemini').status).toBe('installed');
    });

    it('uses the provider id for Cursor install capability instead of its detect key', async () => {
        capabilitiesState.invoke.mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useProviderCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            providerIds: ['cursor'],
            providerDetectKeys: { cursor: 'cursor-agent' },
            installedByProviderId: { cursor: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });

        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(1);
        expect(capabilitiesState.invoke.mock.calls[0]?.[1]?.id).toBe('cli.cursor');
    });

    it('can retry a failed provider without rerunning the full queue', async () => {
        capabilitiesState.invoke
            .mockResolvedValueOnce({ supported: true, response: { ok: false, error: { message: 'boom' } } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useProviderCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            providerIds: ['claude'],
            providerDetectKeys: { claude: 'claude' },
            installedByProviderId: { claude: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('failed');

        await act(async () => {
            await hook.getCurrent().retry('claude');
        });
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('installed');
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(2);
    });
    it('marks a provider without a managed install recipe as not-managed without invoking install', async () => {
        const hook = await renderHook(() => useProviderCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            providerIds: ['hermes'],
            providerDetectKeys: { hermes: 'hermes' },
            installedByProviderId: { hermes: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });

        expect(capabilitiesState.invoke).not.toHaveBeenCalled();
        expect(hook.getCurrent().resolveStatus('hermes')).toMatchObject({ status: 'failed', failureReason: 'not-managed' });
    });

    it('maps the daemon install-not-available refusal to not-managed', async () => {
        capabilitiesState.invoke.mockResolvedValueOnce({
            supported: true,
            response: { ok: false, error: { code: 'install-not-available', message: 'No auto-install recipe' } },
        });

        const hook = await renderHook(() => useProviderCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            providerIds: ['codex'],
            providerDetectKeys: { codex: 'codex' },
            installedByProviderId: { codex: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });

        expect(hook.getCurrent().resolveStatus('codex').failureReason).toBe('not-managed');
    });
});
