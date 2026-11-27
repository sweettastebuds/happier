import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type OmpTerminalDisplayProps = ProviderTerminalDisplayProps;

export const OmpTerminalDisplay = createProviderTerminalDisplay({
  title: 'Oh My Pi',
  accentColor: 'magenta',
});
