/** Thinking levels accepted by `omp` RPC `set_thinking_level` (a superset of Pi's: adds `max`). */
export const OMP_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

const OMP_THINKING_LEVELS_SET: ReadonlySet<string> = new Set(OMP_THINKING_LEVELS);

export function normalizeOmpThinkingLevel(value: unknown): OmpThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return OMP_THINKING_LEVELS_SET.has(normalized) ? (normalized as OmpThinkingLevel) : null;
}

export const OMP_THINKING_LEVEL_ENV = 'HAPPIER_OMP_THINKING_LEVEL' as const;

export function resolveOmpThinkingLevelFromEnv(env: Readonly<Record<string, string | undefined>>): OmpThinkingLevel | null {
  return normalizeOmpThinkingLevel(env[OMP_THINKING_LEVEL_ENV]);
}
