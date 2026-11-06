import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version']],
  // Credentials are per Hermes profile and owned by the user's gateway; Happier does not probe them.
  loginStatusArgs: null,
} satisfies CliDetectSpec;
