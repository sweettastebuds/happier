/**
 * Spawn-time request for a Hermes profile (the `hermes -p <name>` name). Absent means Hermes' active
 * profile. Written by the new-session flow, read by the CLI runtime; once the session has recorded its
 * profile in metadata the recorded profile wins and this request is ignored.
 */
export const HERMES_PROFILE_ENV = 'HAPPIER_HERMES_PROFILE' as const;
