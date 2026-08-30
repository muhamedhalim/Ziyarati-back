import { QueueState } from '../../entities/enums';
import { orderQueueEntries, type OrderableQueueEntry } from './queue-ordering';

const entry = (
  id: string,
  state: QueueState,
  startHhmm: string,
  arrivedHhmm: string,
): OrderableQueueEntry => ({
  id,
  state,
  appointmentStartAt: new Date(`2032-04-14T${startHhmm}:00.000Z`),
  arrivedAt: new Date(`2032-04-14T${arrivedHhmm}:00.000Z`),
});

describe('orderQueueEntries (T171, FR-Q008)', () => {
  it('orders by appointment.start_at first', () => {
    const b = entry('b', QueueState.WAITING, '10:00', '09:00');
    const a = entry('a', QueueState.WAITING, '09:00', '09:30');
    const result = orderQueueEntries([b, a]);
    expect(result.map((r) => r.entry.id)).toEqual(['a', 'b']);
    expect(result.map((r) => r.position)).toEqual([1, 2]);
  });

  it('breaks a tied appointment start_at by arrived_at', () => {
    const late = entry('late', QueueState.WAITING, '09:00', '09:10');
    const early = entry('early', QueueState.WAITING, '09:00', '09:00');
    const result = orderQueueEntries([late, early]);
    expect(result.map((r) => r.entry.id)).toEqual(['early', 'late']);
  });

  it('breaks an equal start_at AND arrived_at tie deterministically by id', () => {
    const b = entry('b-entry', QueueState.WAITING, '09:00', '09:00');
    const a = entry('a-entry', QueueState.WAITING, '09:00', '09:00');
    const first = orderQueueEntries([b, a]).map((r) => r.entry.id);
    const second = orderQueueEntries([a, b]).map((r) => r.entry.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['a-entry', 'b-entry']);
  });

  it('excludes SKIPPED and terminal states from the active order (position: null)', () => {
    const waiting = entry('waiting', QueueState.WAITING, '09:00', '08:50');
    const skipped = entry('skipped', QueueState.SKIPPED, '09:05', '08:40');
    const completed = entry(
      'completed',
      QueueState.COMPLETED,
      '08:00',
      '07:50',
    );
    const cancelled = entry(
      'cancelled',
      QueueState.CANCELLED,
      '08:30',
      '08:20',
    );
    const noShow = entry('no-show', QueueState.NO_SHOW, '08:45', '08:35');

    const result = orderQueueEntries([
      waiting,
      skipped,
      completed,
      cancelled,
      noShow,
    ]);
    const byId = new Map(result.map((r) => [r.entry.id, r.position]));
    expect(byId.get('waiting')).toBe(1);
    expect(byId.get('skipped')).toBeNull();
    expect(byId.get('completed')).toBeNull();
    expect(byId.get('cancelled')).toBeNull();
    expect(byId.get('no-show')).toBeNull();
  });

  it('position updates when an entry changes state — a called entry drops out and the next waiting entry advances', () => {
    const first = entry('first', QueueState.WAITING, '09:00', '08:50');
    const second = entry('second', QueueState.WAITING, '09:10', '08:55');

    const before = orderQueueEntries([first, second]);
    expect(before.map((r) => r.position)).toEqual([1, 2]);

    // `first` is now COMPLETED (left the active order) — `second` must move
    // from position 2 to position 1 without anything being renumbered by hand.
    const completedFirst = { ...first, state: QueueState.COMPLETED };
    const after = orderQueueEntries([completedFirst, second]);
    const byId = new Map(after.map((r) => [r.entry.id, r.position]));
    expect(byId.get('first')).toBeNull();
    expect(byId.get('second')).toBe(1);
  });

  it('computes waitingMinutes relative to the supplied `now`, for every entry regardless of state', () => {
    const now = new Date('2032-04-14T09:30:00.000Z');
    const waiting = entry('waiting', QueueState.WAITING, '09:00', '09:00');
    const result = orderQueueEntries([waiting], now);
    expect(result[0].waitingMinutes).toBe(30);
  });
});
