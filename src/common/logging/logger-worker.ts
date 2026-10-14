/**
 * Side-effect import: the SECOND import of `worker.ts` — see logger-api.ts.
 */
import { Logger } from '@nestjs/common';

import { createRootLogger } from './structured-logger';

Logger.overrideLogger(createRootLogger('worker'));
