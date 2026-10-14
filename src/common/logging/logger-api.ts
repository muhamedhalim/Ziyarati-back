/**
 * Side-effect import: the SECOND import of `main.ts`, right after the tracing
 * preload. Installs the structured logger as Nest's static logger before any
 * module is evaluated, so even module-load-time `new Logger(x).warn(...)`
 * calls come out as JSON instead of Nest's text format.
 *
 * Must not be merged into tracing-api.ts: imports are hoisted, and this file's
 * dependency graph loads `typeorm`/`pg`, which tracing has to patch first.
 */
import { Logger } from '@nestjs/common';

import { createRootLogger } from './structured-logger';

Logger.overrideLogger(createRootLogger('api'));
