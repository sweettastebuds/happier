/**
 * The Hermes profile seam. A Hermes profile (a separate HERMES_HOME) is chosen when a session starts,
 * recorded with the session, and used again by every resume; there is no in-session switching.
 *
 * - Requesting a profile at start: spawn the session with `HAPPIER_HERMES_PROFILE=<name>` in its
 *   environment (the `-p` name). Absent means Hermes' active profile.
 * - Recorded in session metadata once the gateway owner is known: `hermesProfileId` (the owner's
 *   profile identity, which is the profile home path) and `hermesProfileName` (the `-p` name, when
 *   Hermes reports a usable one).
 * - Resume reads those metadata fields first; the environment request is ignored for a recorded
 *   session, and the attach must resolve to the same `hermesProfileId` or the resume is refused.
 */
import { providers } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';

import { assertValidHermesProfileName } from './attach';
import type { HermesBoundProfile, HermesProfileBinding } from './HermesGatewayBackend';

export const HERMES_PROFILE_ENV = providers.hermes.HERMES_PROFILE_ENV;

type HermesProfileMetadata = Readonly<{ hermesProfileId?: unknown; hermesProfileName?: unknown }>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveHermesProfileBinding(params: Readonly<{
  metadata: Metadata | null | undefined;
  env: NodeJS.ProcessEnv;
}>): HermesProfileBinding {
  const recorded = (params.metadata ?? {}) as HermesProfileMetadata;
  const recordedId = readString(recorded.hermesProfileId);
  if (recordedId) return { name: readString(recorded.hermesProfileName), expectedProfileId: recordedId };

  const requested = readString(params.env[HERMES_PROFILE_ENV]);
  if (requested) assertValidHermesProfileName(requested);
  return { name: requested, expectedProfileId: null };
}

/** Returns the same object when the metadata already carries this binding, so no write is published. */
export function applyHermesProfileBinding(metadata: Metadata, bound: HermesBoundProfile): Metadata {
  const current = metadata as Metadata & HermesProfileMetadata;
  const nextName = bound.name ?? readString(current.hermesProfileName);
  if (readString(current.hermesProfileId) === bound.profileId && readString(current.hermesProfileName) === nextName) {
    return metadata;
  }
  return {
    ...metadata,
    hermesProfileId: bound.profileId,
    ...(nextName ? { hermesProfileName: nextName } : {}),
  } as Metadata;
}
