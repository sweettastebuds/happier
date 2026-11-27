import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { applyHermesProfileBinding, HERMES_PROFILE_ENV, resolveHermesProfileBinding } from './hermesProfile';

const base = { path: '/p', host: 'h' } as Metadata;

describe('resolveHermesProfileBinding', () => {
  it('uses the profile requested at session start via the spawn environment', () => {
    expect(resolveHermesProfileBinding({ metadata: base, env: { [HERMES_PROFILE_ENV]: 'work' } }))
      .toEqual({ name: 'work', expectedProfileId: null });
  });

  it('defaults to the active Hermes profile when none is requested', () => {
    expect(resolveHermesProfileBinding({ metadata: base, env: {} })).toEqual({ name: null, expectedProfileId: null });
    expect(resolveHermesProfileBinding({ metadata: base, env: { [HERMES_PROFILE_ENV]: '  ' } })).toEqual({ name: null, expectedProfileId: null });
  });

  it('keeps a recorded session on its profile: resume ignores any newly requested profile', () => {
    const recorded = { ...base, hermesProfileId: '/h/.hermes/profiles/work', hermesProfileName: 'work' } as Metadata;
    expect(resolveHermesProfileBinding({ metadata: recorded, env: { [HERMES_PROFILE_ENV]: 'other' } }))
      .toEqual({ name: 'work', expectedProfileId: '/h/.hermes/profiles/work' });
  });

  it('pins by identity alone when only the profile home is known', () => {
    const recorded = { ...base, hermesProfileId: '/custom/home' } as Metadata;
    expect(resolveHermesProfileBinding({ metadata: recorded, env: {} })).toEqual({ name: null, expectedProfileId: '/custom/home' });
  });

  it('rejects a requested profile name that is not a safe Hermes profile name', () => {
    expect(() => resolveHermesProfileBinding({ metadata: base, env: { [HERMES_PROFILE_ENV]: '--start' } })).toThrow(/Hermes profile name/);
  });
});

describe('applyHermesProfileBinding', () => {
  it('records the resolved profile identity and name in session metadata', () => {
    const next = applyHermesProfileBinding(base, { profileId: '/h/.hermes/profiles/work', name: 'work' });
    expect(next).toMatchObject({ hermesProfileId: '/h/.hermes/profiles/work', hermesProfileName: 'work' });
  });

  it('keeps metadata identity (no write) when nothing changed, and keeps a recorded name Hermes no longer reports', () => {
    const bound = applyHermesProfileBinding(base, { profileId: '/h', name: 'work' });
    expect(applyHermesProfileBinding(bound, { profileId: '/h', name: 'work' })).toBe(bound);
    const unnamed = applyHermesProfileBinding(bound, { profileId: '/h', name: null });
    expect((unnamed as Record<string, unknown>).hermesProfileName).toBe('work');
  });
});
