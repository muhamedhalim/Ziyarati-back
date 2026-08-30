import { QueueState } from '../../entities/enums';

/**
 * Spec 014 (Clinic Platform Completion) — T171 (US10, FR-Q008,
 * data-model.md §1.10). Queue position is DERIVED at read time from a
 * stated ordering policy — `appointment.start_at`, then `arrived_at` — and
 * is never stored on the entity, so nothing needs renumbering when an entry
 * changes state (see `QueueEntry`'s own docblock).
 *
 * Only entries still in the ACTIVE order carry a position: `SKIPPED` has
 * deliberately left the active order until recalled (FR-Q010), and the
 * three terminal states (`COMPLETED`, `NO_SHOW`, `CANCELLED`) have left the
 * queue altogether. Both get `position: null`.
 */
export const ACTIVE_QUEUE_ORDER_STATES: readonly QueueState[] = [
  QueueState.WAITING,
  QueueState.CALLED,
  QueueState.IN_CONSULTATION,
];

export interface OrderableQueueEntry {
  id: string;
  state: QueueState;
  appointmentStartAt: Date;
  arrivedAt: Date;
}

export interface OrderedQueueEntry<T extends OrderableQueueEntry> {
  entry: T;
  /** 1-based position within the active order; `null` when not in it. */
  position: number | null;
  waitingMinutes: number;
}

/**
 * Orders `entries` by `appointmentStartAt` then `arrivedAt` (a stable,
 * deterministic id tiebreak for entries sharing both), and assigns each
 * entry still in the active order (see `ACTIVE_QUEUE_ORDER_STATES`) the next
 * 1-based position in that order. `waitingMinutes` is computed for every
 * entry regardless of state, relative to `now`.
 */
export function orderQueueEntries<T extends OrderableQueueEntry>(
  entries: T[],
  now: Date = new Date(),
): OrderedQueueEntry<T>[] {
  const sorted = [...entries].sort((a, b) => {
    const startDiff =
      a.appointmentStartAt.getTime() - b.appointmentStartAt.getTime();
    if (startDiff !== 0) return startDiff;
    const arrivedDiff = a.arrivedAt.getTime() - b.arrivedAt.getTime();
    if (arrivedDiff !== 0) return arrivedDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let position = 0;
  return sorted.map((entry) => {
    const inActiveOrder = ACTIVE_QUEUE_ORDER_STATES.includes(entry.state);
    const waitingMinutes = Math.max(
      0,
      Math.round((now.getTime() - entry.arrivedAt.getTime()) / 60_000),
    );
    return {
      entry,
      position: inActiveOrder ? ++position : null,
      waitingMinutes,
    };
  });
}
