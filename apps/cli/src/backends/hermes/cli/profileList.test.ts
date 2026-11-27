import { describe, expect, it } from 'vitest';

import type { HermesCommandInvocation, HermesCommandRunner } from '../gateway/attach';
import { listHermesProfiles, parseHermesProfileList } from './profileList';

// Fixture provenance: the table layout is `hermes_cli/profile_cmd.py::_profile_list` (Hermes
// 6b21d0564de0): `{marker:2}{label:<15} {model:<28} {gateway:<12} {alias:<12} {distribution}`, where the
// label is `Display Name (id)` when a display name is set. No live capture exists; derived from source.
const TABLE = [
  '',
  ' Profile          Model                        Gateway      Alias        Distribution',
  ' ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────',
  ' ◆default         claude-sonnet-4              running      —            —',
  '  work            gpt-5 (preview)              stopped      work         —',
  '  Research Bot (research) —                    stopped      research     —',
  '  a-very-long-profile-name —                   stopped      —            —',
  '',
  'Warning: profile "work" shares a bot credential with the default profile.',
  '',
].join('\n');

describe('parseHermesProfileList', () => {
  it('reads profile ids, the active marker, and display-name labels from the table', () => {
    expect(parseHermesProfileList(TABLE)).toEqual([
      { name: 'default', active: true },
      { name: 'work', active: false },
      { name: 'research', active: false },
      { name: 'a-very-long-profile-name', active: false },
    ]);
  });

  it('returns no profiles for the empty listing and for unrecognized output', () => {
    expect(parseHermesProfileList('No profiles found.\n')).toEqual([]);
    expect(parseHermesProfileList('Traceback (most recent call last):\n  boom\n')).toEqual([]);
  });
});

describe('listHermesProfiles', () => {
  const launch = { command: 'hermes', args: ['--flag'] } as const;

  it('runs `profile list` through the launch spec and parses stdout', async () => {
    const calls: HermesCommandInvocation[] = [];
    const run: HermesCommandRunner = async (invocation) => {
      calls.push(invocation);
      return { exitCode: 0, stdout: TABLE, stderr: '' };
    };
    const profiles = await listHermesProfiles({ launch, env: { A: '1' }, run });
    expect(profiles.map((p) => p.name)).toEqual(['default', 'work', 'research', 'a-very-long-profile-name']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('hermes');
    expect(calls[0]?.args).toEqual(['--flag', 'profile', 'list']);
  });

  it('reports a non-zero exit as an error instead of an empty list', async () => {
    const run: HermesCommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    await expect(listHermesProfiles({ launch, env: {}, run })).rejects.toThrow(/exit code 1/);
  });
});
