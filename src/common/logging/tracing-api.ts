/**
 * Side-effect import: MUST be the first import of `main.ts` so OpenTelemetry
 * (when `OTEL_ENABLED=true`) patches `http`/`express`/`pg`/`ioredis` before
 * they are loaded. A no-op otherwise. See tracing.ts.
 */
import { startTracing } from './tracing';

startTracing('api');
