import { classifyMetaFailure } from './meta-error-classification';

describe('classifyMetaFailure', () => {
  it.each([
    100, 131008, 131009, 131026, 131047, 131049, 131051, 132000, 132001, 132005,
    132007, 132012, 132015, 132016,
  ])('%i is permanent', (code) =>
    expect(classifyMetaFailure(code)).toBe('permanent'),
  );

  it.each([130429, 131000, 131048, 131056])('%i is transient', (code) =>
    expect(classifyMetaFailure(code)).toBe('transient'),
  );

  it('unknown or missing codes are transient — retried within the queue bounds, never dropped', () => {
    expect(classifyMetaFailure(424242)).toBe('transient');
    expect(classifyMetaFailure(undefined)).toBe('transient');
    expect(classifyMetaFailure(null)).toBe('transient');
  });
});
