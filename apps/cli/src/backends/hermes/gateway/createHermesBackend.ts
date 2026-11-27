import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions } from '@/agent/core';

import {
  HermesGatewayBackend,
  type HermesBoundProfile,
  type HermesProfileBinding,
} from './HermesGatewayBackend';

export interface HermesBackendOptions extends AgentFactoryOptions {
  permissionHandler?: AcpPermissionHandler;
  /** Resolved by the runtime from session metadata / spawn env; see hermesProfile.ts. */
  profile?: HermesProfileBinding;
  onProfileBound?: (profile: HermesBoundProfile) => void | Promise<void>;
}

export function createHermesBackend(options: HermesBackendOptions): AgentBackend {
  return new HermesGatewayBackend({
    cwd: options.cwd,
    env: options.env,
    profile: options.profile,
    permissionHandler: options.permissionHandler,
    onProfileBound: options.onProfileBound,
  });
}
