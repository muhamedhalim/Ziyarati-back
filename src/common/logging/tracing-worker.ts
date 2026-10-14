/**
 * Side-effect import: MUST be the first import of `worker.ts` — see
 * tracing-api.ts and tracing.ts.
 */
import { startTracing } from './tracing';

startTracing('worker');
