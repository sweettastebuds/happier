import { describe, expect, it } from 'vitest';

import { createHermesCliCapability } from './capability';

const context = { cliSnapshot: { clis: { hermes: { available: true, resolvedPath: '/bin/hermes' } } } } as never;
const profiles = [{ name: 'default', active: true }, { name: 'work', active: false }];

describe('cli.hermes capability', () => {
  it('adds the profiles only when asked', async () => {
    const capability = createHermesCliCapability({ listProfiles: async () => profiles });
    const plain = await capability.detect({ request: { id: 'cli.hermes' }, context }) as Record<string, unknown>;
    expect(plain.available).toBe(true);
    expect(plain).not.toHaveProperty('profiles');

    const withProfiles = await capability.detect({
      request: { id: 'cli.hermes', params: { includeProfiles: true } },
      context,
    }) as Record<string, unknown>;
    expect(withProfiles.profiles).toEqual(profiles);
  });

  it('surfaces a listing failure on the result and skips listing when Hermes is missing', async () => {
    const failing = createHermesCliCapability({ listProfiles: async () => { throw new Error('exit code 1'); } });
    const result = await failing.detect({ request: { id: 'cli.hermes', params: { includeProfiles: true } }, context }) as Record<string, unknown>;
    expect(result.profilesError).toMatch(/exit code 1/);
    expect(result).not.toHaveProperty('profiles');

    let called = false;
    const missing = createHermesCliCapability({ listProfiles: async () => { called = true; return profiles; } });
    const absent = await missing.detect({
      request: { id: 'cli.hermes', params: { includeProfiles: true } },
      context: { cliSnapshot: { clis: {} } } as never,
    }) as Record<string, unknown>;
    expect(absent.available).toBe(false);
    expect(called).toBe(false);
  });
});
