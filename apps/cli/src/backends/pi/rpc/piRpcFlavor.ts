import type { AgentId } from '@happier-dev/agents';

export type PiRpcFlavorId = 'pi' | 'omp';

/**
 * The seams where the pi JSONL RPC family differs between agents. `PiRpcBackend` stays the single
 * owner of the transport and turn lifecycle; a flavor only names the facts the backend consumes.
 *
 * `omp` (oh-my-pi, `omp --mode rpc-ui`) is a separate agent id that speaks the same transport.
 */
export type PiRpcFlavor = Readonly<{
  id: PiRpcFlavorId;
  agentId: Extract<AgentId, PiRpcFlavorId>;
  /** RPC command that lists slash commands. */
  commandsRpc: 'get_commands' | 'get_available_commands';
  /** Explicit session-selection flag; value is always a session id or file path (never the bare picker form). */
  resumeFlag: '--session' | '--resume';
  /** Environment variables the child must never inherit (they redirect it to another agent's state). */
  scrubbedEnvKeys: readonly string[];
  /** Opt in to the structured `ask` dialog right after spawn. */
  askDialogOptIn: boolean;
  /** Tool approvals arrive as an extension-UI `select` whose last option is `Deny`. */
  toolApprovalViaSelect: boolean;
  /**
   * `extension`: Happier injects a pi extension that reports the model catalog on stderr.
   * `rpc`: the catalog is read with `get_available_models` (no Happier-owned extension is loaded).
   */
  modelCatalog: 'extension' | 'rpc';
}>;

// Source: oh-my-pi packages/utils/src/dirs.ts (profile + agent dir resolution) and
// packages/coding-agent/src/cli/args.ts (session dir). Any of these would point omp at pi's state.
const OMP_SCRUBBED_ENV_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_CONFIG_DIR',
  'PI_PROFILE',
  'OMP_PROFILE',
] as const;

export const PI_RPC_FLAVORS: Readonly<Record<PiRpcFlavorId, PiRpcFlavor>> = {
  pi: {
    id: 'pi',
    agentId: 'pi',
    commandsRpc: 'get_commands',
    resumeFlag: '--session',
    scrubbedEnvKeys: [],
    askDialogOptIn: false,
    toolApprovalViaSelect: false,
    modelCatalog: 'extension',
  },
  omp: {
    id: 'omp',
    agentId: 'omp',
    commandsRpc: 'get_available_commands',
    resumeFlag: '--resume',
    scrubbedEnvKeys: OMP_SCRUBBED_ENV_KEYS,
    askDialogOptIn: true,
    toolApprovalViaSelect: true,
    modelCatalog: 'rpc',
  },
};

/** Env names are case-insensitive on Windows, so match on the upper-cased name everywhere. */
export function removeScrubbedEnvKeys<T extends Record<string, string | undefined>>(
  flavor: PiRpcFlavor,
  env: T,
): T {
  if (flavor.scrubbedEnvKeys.length === 0) return env;
  const scrubbed = new Set(flavor.scrubbedEnvKeys.map((key) => key.toUpperCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !scrubbed.has(key.toUpperCase())),
  ) as T;
}
