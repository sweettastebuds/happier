/**
 * `hermes [-p <profile>] gateway attach --json`: the only way Happier reaches Hermes.
 *
 * Happier connects to a gateway the user already runs. It never starts, restarts, recovers or
 * stops one, so this module never passes `--start` or `--recover` and never invokes `gateway run`.
 * A ticket is single-use (30 s), so every (re)connect must attach again.
 *
 * Contract source: Hermes `hermes_cli/gateway_runtime_cli.py` (6b21d0564de0).
 */

export type HermesCommandInvocation = Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

export type HermesCommandResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

/** Child-process boundary; production uses `runHermesCommand`. */
export type HermesCommandRunner = (invocation: HermesCommandInvocation) => Promise<HermesCommandResult>;

export type HermesGatewayUnavailableKind =
  | 'invalid_profile'
  | 'launch_failed'
  | 'invalid_invocation'
  | 'incompatible'
  | 'profile_mismatch'
  | 'gateway_not_running'
  | 'draining'
  | 'inaccessible'
  | 'malformed_output';

export class HermesGatewayUnavailableError extends Error {
  readonly kind: HermesGatewayUnavailableKind;
  readonly exitCode: number | null;

  constructor(kind: HermesGatewayUnavailableKind, message: string, exitCode: number | null = null) {
    super(message);
    this.name = 'HermesGatewayUnavailableError';
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export function isHermesGatewayUnavailableError(error: unknown): error is HermesGatewayUnavailableError {
  return error instanceof HermesGatewayUnavailableError;
}

export type HermesGatewayAttachment = Readonly<{
  url: string;
  /** Single-use credential. Never log it or put it in an error message. */
  ticket: string;
  protocol: string;
  protocols: readonly string[];
  /** Owner-side profile identity: the profile's home path, not the `-p` name. */
  profileId: string;
  instanceId: string | null;
  runtimeProtocol: number | null;
  capabilities: readonly string[];
  codeSha: string | null;
  clientCodeSha: string | null;
  /** The gateway outlived `hermes update`: the user must restart it. */
  codeDrift: boolean;
}>;

const HERMES_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidHermesProfileName(profile: string): void {
  if (!HERMES_PROFILE_NAME.test(profile)) {
    throw new HermesGatewayUnavailableError('invalid_profile', `Invalid Hermes profile name: ${JSON.stringify(profile)}`);
  }
}

export function buildHermesAttachArgs(profile?: string | null): string[] {
  if (profile === undefined || profile === null) return ['gateway', 'attach', '--json'];
  assertValidHermesProfileName(profile);
  return ['-p', profile, 'gateway', 'attach', '--json'];
}

function describeProfile(profile: string | null | undefined): string {
  return profile ? `Hermes profile "${profile}"` : 'the active Hermes profile';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function failureForExitCode(exitCode: number | null, profile: string | null | undefined, verdict: Record<string, unknown> | null): HermesGatewayUnavailableError {
  const label = describeProfile(profile);
  const detail = asString(verdict?.detail);
  const suffix = detail ? ` (${detail})` : '';
  switch (exitCode) {
    case 2:
      return new HermesGatewayUnavailableError('invalid_invocation', `Hermes rejected the gateway attach request for ${label}.`, exitCode);
    case 3:
      return new HermesGatewayUnavailableError('incompatible', `The Hermes gateway for ${label} is incompatible with this Hermes install. Update Hermes and restart your gateway.${suffix}`, exitCode);
    case 4:
      return new HermesGatewayUnavailableError('profile_mismatch', `Hermes refused access to ${label}: the profile does not match the running gateway or you are not authorized for it.${suffix}`, exitCode);
    case 5:
      return new HermesGatewayUnavailableError('gateway_not_running', `No running Hermes gateway was found for ${label} (it is absent or still starting). Start your Hermes gateway (for example "hermes gateway run"), then try again. Happier never starts it for you.`, exitCode);
    case 6:
      return new HermesGatewayUnavailableError('draining', `The Hermes gateway for ${label} is restarting or updating. Wait for it to finish, then try again.${suffix}`, exitCode);
    case 7:
      return new HermesGatewayUnavailableError('inaccessible', `The Hermes gateway for ${label} is not accessible to this user (another account, an elevated process, or a conflicting supervisor owns it).${suffix}`, exitCode);
    default:
      return new HermesGatewayUnavailableError('invalid_invocation', `"hermes gateway attach" failed for ${label} with exit code ${exitCode ?? 'unknown'}.${suffix}`, exitCode);
  }
}

function parseAttachment(verdict: Record<string, unknown>): HermesGatewayAttachment | null {
  const url = asString(verdict.url);
  const ticket = asString(verdict.ticket);
  const endpoint = asRecord(verdict.endpoint);
  const profileId = asString(endpoint?.profile_id);
  if (!url || !ticket || !endpoint || !profileId) return null;

  const protocol = asString(verdict.protocol) ?? 'hermes-gateway-v1';
  const protocols = Array.isArray(verdict.protocols) && verdict.protocols.every((p) => typeof p === 'string')
    ? verdict.protocols as string[]
    : [protocol, `hermes-gateway-ticket.${ticket}`];
  const codeSha = asString(endpoint.code_sha);
  const clientCodeSha = asString(verdict.client_code_sha);
  return {
    url,
    ticket,
    protocol,
    protocols,
    profileId,
    instanceId: asString(endpoint.instance_id),
    runtimeProtocol: typeof endpoint.runtime_protocol === 'number' ? endpoint.runtime_protocol : null,
    capabilities: Array.isArray(endpoint.capabilities) ? endpoint.capabilities.filter((c): c is string => typeof c === 'string') : [],
    codeSha,
    clientCodeSha,
    codeDrift: codeSha !== null && clientCodeSha !== null && codeSha !== clientCodeSha,
  };
}

export async function attachHermesGateway(params: Readonly<{
  launch: Readonly<{ command: string; args: readonly string[] }>;
  /** Hermes profile name for `-p`; omitted means Hermes' active profile. */
  profile?: string | null;
  env: NodeJS.ProcessEnv;
  run: HermesCommandRunner;
  signal?: AbortSignal;
}>): Promise<HermesGatewayAttachment> {
  const args = [...params.launch.args, ...buildHermesAttachArgs(params.profile)];

  let result: HermesCommandResult;
  try {
    result = await params.run({ command: params.launch.command, args, env: params.env, signal: params.signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HermesGatewayUnavailableError('launch_failed', `Could not run the Hermes CLI (${reason}). Install Hermes or set HAPPIER_HERMES_PATH.`);
  }

  const verdict = parseJsonObject(result.stdout);
  if (result.exitCode !== 0) throw failureForExitCode(result.exitCode, params.profile, verdict);

  const attachment = verdict ? parseAttachment(verdict) : null;
  if (!attachment) {
    throw new HermesGatewayUnavailableError('malformed_output', 'The Hermes CLI returned an unrecognized "gateway attach --json" result. Update Hermes and try again.');
  }
  return attachment;
}
