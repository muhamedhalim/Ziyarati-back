import { LOG_EVENT } from './log-events';
import type { StructuredLogger } from './structured-logger';

/**
 * Process-level crash handling for a process root (API worker process, BullMQ
 * worker).
 *
 * ONE `uncaughtException` listener covers both failure kinds: under Node's
 * default `--unhandled-rejections=throw` mode an unhandled rejection is raised
 * as an uncaught exception with `origin === 'unhandledRejection'`. Registering
 * an `unhandledRejection` listener instead would *disable* that default crash
 * and leave the process running in an unknown state — exactly what this must
 * not do.
 *
 * Registering any `uncaughtException` listener also stops Node from exiting by
 * itself, so this handler owns the exit:
 *   1. log the failure and its stack ONCE, at `fatal`;
 *   2. run the root's normal graceful shutdown (closes HTTP, BullMQ workers,
 *      DB/Redis) bounded by `timeoutMs` — the process is NOT kept alive;
 *   3. exit 1 so the orchestrator (ECS, cluster primary, docker) restarts it.
 * A second failure during that window exits immediately.
 */
export interface FatalHandlerOptions {
  logger: StructuredLogger;
  /** The root's graceful shutdown; must not call process.exit itself. */
  shutdown: () => Promise<void>;
  timeoutMs?: number;
  /** Test seam. */
  exit?: (code: number) => void;
  /** Test seam. */
  target?: Pick<NodeJS.Process, 'on'>;
}

export function installFatalHandlers(
  options: FatalHandlerOptions,
): (err: unknown, origin?: string) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? 10_000;
  let handling = false;

  const handler = (err: unknown, origin?: string): void => {
    if (handling) {
      // A failure while already shutting down: do not loop, do not wait.
      try {
        options.logger.event(
          'fatal',
          LOG_EVENT.PROCESS_UNCAUGHT_EXCEPTION,
          'Second fatal error during shutdown; exiting now.',
          {
            error: err,
            origin: origin ?? 'uncaughtException',
          },
        );
      } finally {
        exit(1);
      }
      return;
    }
    handling = true;
    const isRejection = origin === 'unhandledRejection';
    options.logger.event(
      'fatal',
      isRejection
        ? LOG_EVENT.PROCESS_UNHANDLED_REJECTION
        : LOG_EVENT.PROCESS_UNCAUGHT_EXCEPTION,
      isRejection
        ? 'Unhandled promise rejection; shutting down for a restart.'
        : 'Uncaught exception; shutting down for a restart.',
      {
        error: err instanceof Error ? err : new Error(String(err)),
        origin: origin ?? 'uncaughtException',
      },
    );

    const timer = setTimeout(() => exit(1), timeoutMs);
    timer.unref?.();
    options
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        exit(1);
      });
  };

  (options.target ?? process).on('uncaughtException', handler);
  return handler;
}
