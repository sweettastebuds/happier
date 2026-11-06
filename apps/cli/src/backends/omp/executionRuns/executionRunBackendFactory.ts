import { createPiBackend, type PiBackendOptions } from '@/backends/pi/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(
  (opts: PiBackendOptions) => createPiBackend({ ...opts, flavor: 'omp' }),
);
