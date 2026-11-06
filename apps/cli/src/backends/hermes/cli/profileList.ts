/**
 * Lists the Hermes profiles on this machine by running `hermes profile list`.
 *
 * Hermes has no machine-readable form of this command, so the table is parsed. The layout is
 * `hermes_cli/profile_cmd.py::_profile_list` (Hermes 6b21d0564de0):
 * `{marker:2}{label:<15} {model:<28} ...`, where the label is `Display Name (id)` when a display
 * name is set and `◆` marks the active profile.
 */
import { assertValidHermesProfileName, type HermesCommandRunner } from '../gateway/attach';

export type HermesProfileListEntry = Readonly<{ name: string; active: boolean }>;

const NAME_COLUMN_WIDTH = 15;
const SEPARATOR_LINE = /^\s*[─-]{3,}/;
const DISPLAY_LABEL_ID = /\(([A-Za-z0-9][A-Za-z0-9._-]{0,63})\)/;

function readProfileName(row: string): string | null {
  const firstToken = /^\S+/.exec(row)?.[0];
  if (!firstToken) return null;
  // A bare id fits the padded name column and is followed by blanks up to the model column; a
  // `Display Name (id)` label puts more text in that column.
  const bareId = row.slice(firstToken.length, NAME_COLUMN_WIDTH + 1).trim() === '';
  return bareId ? firstToken : DISPLAY_LABEL_ID.exec(row)?.[1] ?? null;
}

export function parseHermesProfileList(stdout: string): HermesProfileListEntry[] {
  const lines = stdout.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => SEPARATOR_LINE.test(line));
  if (separatorIndex < 0) return [];

  const profiles: HermesProfileListEntry[] = [];
  for (const line of lines.slice(separatorIndex + 1)) {
    if (line.trim() === '') break;
    const name = readProfileName(line.slice(2));
    if (!name) continue;
    try {
      assertValidHermesProfileName(name);
    } catch {
      continue;
    }
    if (profiles.some((profile) => profile.name === name)) continue;
    profiles.push({ name, active: line.slice(0, 2).includes('◆') });
  }
  return profiles;
}

export async function listHermesProfiles(params: Readonly<{
  launch: Readonly<{ command: string; args: readonly string[] }>;
  env: NodeJS.ProcessEnv;
  run: HermesCommandRunner;
  signal?: AbortSignal;
}>): Promise<HermesProfileListEntry[]> {
  const result = await params.run({
    command: params.launch.command,
    args: [...params.launch.args, 'profile', 'list'],
    env: params.env,
    signal: params.signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(`"hermes profile list" failed with exit code ${result.exitCode ?? 'unknown'}.`);
  }
  return parseHermesProfileList(result.stdout);
}
