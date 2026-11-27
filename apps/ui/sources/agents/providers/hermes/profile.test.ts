import { describe, expect, it } from 'vitest';

import {
    buildNewSessionOptionsFromUiState,
    buildSpawnEnvironmentVariablesFromUiState,
} from '@/agents/registry/registryUiBehavior';
import { makeSettings } from '@/agents/registry/registryUiBehavior.testHelpers';

import { readHermesProfilesFromCapability } from './profile';

describe('hermes profile at session start', () => {
    it('carries the chosen profile from the new-session option state into the spawn environment', () => {
        const newSessionOptions = buildNewSessionOptionsFromUiState({
            agentId: 'hermes',
            agentOptionState: { hermesProfile: 'work' },
        });
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'hermes',
            settings: makeSettings({}),
            environmentVariables: { KEEP: '1' },
            newSessionOptions,
        })).toEqual({ KEEP: '1', HAPPIER_HERMES_PROFILE: 'work' });
    });

    it('requests no profile when none was chosen, leaving the environment untouched', () => {
        const env = { KEEP: '1' };
        const newSessionOptions = buildNewSessionOptionsFromUiState({ agentId: 'hermes', agentOptionState: {} });
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'hermes',
            settings: makeSettings({}),
            environmentVariables: env,
            newSessionOptions,
        })).toBe(env);
    });

    it('does not touch the spawn environment of other agents', () => {
        const env = { KEEP: '1' };
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'codex',
            settings: makeSettings({}),
            environmentVariables: env,
            newSessionOptions: { hermesProfile: 'work' },
        })).toBe(env);
    });
});

describe('readHermesProfilesFromCapability', () => {
    it('reads the machine profiles from the cli.hermes result', () => {
        expect(readHermesProfilesFromCapability({
            ok: true,
            checkedAt: 1,
            data: { available: true, profiles: [{ name: 'default', active: true }, { name: 'work', active: false }, { bad: 1 }] },
        })).toEqual({ status: 'ready', profiles: [{ name: 'default', active: true }, { name: 'work', active: false }] });
    });

    it('distinguishes a listing failure, a missing CLI and a failed request', () => {
        expect(readHermesProfilesFromCapability({ ok: true, checkedAt: 1, data: { available: true, profilesError: 'x' } }))
            .toEqual({ status: 'error' });
        expect(readHermesProfilesFromCapability({ ok: true, checkedAt: 1, data: { available: false } }))
            .toEqual({ status: 'unavailable' });
        expect(readHermesProfilesFromCapability({ ok: false, checkedAt: 1, error: { message: 'boom' } }))
            .toEqual({ status: 'error' });
        expect(readHermesProfilesFromCapability(undefined)).toEqual({ status: 'error' });
    });
});
