import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import {
    applyHermesProfileEnv,
    HERMES_NEW_SESSION_OPTION_PROFILE,
    readHermesProfileSelection,
} from './profile';

function getChipFactory(): typeof import('@/agents/providers/hermes/HermesProfileChip').createHermesProfileChip {
    // Lazy require so Node-side tests can import `@/agents/catalog` without resolving native icon deps.
    return require('@/agents/providers/hermes/HermesProfileChip').createHermesProfileChip;
}

export const HERMES_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        buildNewSessionOptions: ({ agentOptionState }) => ({
            [HERMES_NEW_SESSION_OPTION_PROFILE]: readHermesProfileSelection(agentOptionState),
        }),
        getAgentInputExtraActionChips: ({ agentOptionState, setAgentOptionState, machineId, serverId }) => [
            getChipFactory()({
                profile: readHermesProfileSelection(agentOptionState),
                machineId: machineId ?? null,
                serverId: serverId ?? null,
                setProfile: (next) => setAgentOptionState(HERMES_NEW_SESSION_OPTION_PROFILE, next),
            }),
        ],
    },
    payload: {
        buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }) =>
            applyHermesProfileEnv(environmentVariables, readHermesProfileSelection(newSessionOptions)),
    },
};
