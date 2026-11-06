import { describe, expect, it } from 'vitest';

import { normalizeOmpThinkingLevel, resolveOmpThinkingLevelFromEnv } from './thinking.js';

describe('normalizeOmpThinkingLevel', () => {
  it('accepts OMP-only max and rejects unknown levels', () => {
    expect(normalizeOmpThinkingLevel(' MAX ')).toBe('max');
    expect(normalizeOmpThinkingLevel('ultra')).toBeNull();
    expect(normalizeOmpThinkingLevel(undefined)).toBeNull();
  });
});

describe('resolveOmpThinkingLevelFromEnv', () => {
  it('reads the omp-owned env variable, not pi\'s', () => {
    expect(resolveOmpThinkingLevelFromEnv({ HAPPIER_OMP_THINKING_LEVEL: 'max' })).toBe('max');
    expect(resolveOmpThinkingLevelFromEnv({ HAPPIER_PI_THINKING_LEVEL: 'high' })).toBeNull();
  });
});
