import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type HermesTerminalDisplayProps = ProviderTerminalDisplayProps;

export const HermesTerminalDisplay = createProviderTerminalDisplay({
  title: 'Hermes',
  accentColor: 'yellow',
});
