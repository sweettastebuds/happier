import { providers } from '@happier-dev/agents';

import type { CapabilityDetectResult } from '@/sync/api/capabilities/capabilitiesProtocol';

/** Key of the Hermes profile in the new-session option state and in `newSessionOptions`. */
export const HERMES_NEW_SESSION_OPTION_PROFILE = 'hermesProfile' as const;

export type HermesProfileOption = Readonly<{ name: string; active: boolean }>;

export type HermesProfilesReadResult =
    | Readonly<{ status: 'ready'; profiles: readonly HermesProfileOption[] }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'error' }>;

export function readHermesProfileSelection(state: Record<string, unknown> | null | undefined): string | null {
    const value = state?.[HERMES_NEW_SESSION_OPTION_PROFILE];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Requests the profile for the spawned session; the CLI records it with the session on start. */
export function applyHermesProfileEnv(
    env: Record<string, string> | undefined,
    profile: string | null,
): Record<string, string> | undefined {
    if (!profile) return env;
    return { ...(env ?? {}), [providers.hermes.HERMES_PROFILE_ENV]: profile };
}

/** Reads the `cli.hermes` capability result requested with `includeProfiles`. */
export function readHermesProfilesFromCapability(result: CapabilityDetectResult | undefined): HermesProfilesReadResult {
    if (!result || !result.ok) return { status: 'error' };
    const data = result.data;
    if (!data || typeof data !== 'object') return { status: 'error' };
    const record = data as Record<string, unknown>;
    if (record.available !== true) return { status: 'unavailable' };
    if (!Array.isArray(record.profiles)) return { status: 'error' };
    const profiles: HermesProfileOption[] = [];
    for (const entry of record.profiles) {
        if (!entry || typeof entry !== 'object') continue;
        const { name, active } = entry as Record<string, unknown>;
        if (typeof name !== 'string' || name.length === 0) continue;
        profiles.push({ name, active: active === true });
    }
    return { status: 'ready', profiles };
}
