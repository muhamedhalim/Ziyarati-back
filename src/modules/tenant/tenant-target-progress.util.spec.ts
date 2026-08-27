import { computeMetricProgress } from './tenant-target-progress.util';

describe('computeMetricProgress', () => {
  it('undefined target -> everything null, not completed', () => {
    expect(computeMetricProgress(undefined, 5)).toEqual({
      target: null,
      current: 5,
      remaining: null,
      percentage: null,
      isCompleted: false,
    });
  });

  it('null target -> everything null, not completed', () => {
    expect(computeMetricProgress(null, 0)).toEqual({
      target: null,
      current: 0,
      remaining: null,
      percentage: null,
      isCompleted: false,
    });
  });

  it('target = 0 -> trivially completed regardless of current', () => {
    expect(computeMetricProgress(0, 0)).toEqual({
      target: 0,
      current: 0,
      remaining: 0,
      percentage: 100,
      isCompleted: true,
    });
    expect(computeMetricProgress(0, 40)).toEqual({
      target: 0,
      current: 40,
      remaining: 0,
      percentage: 100,
      isCompleted: true,
    });
  });

  it('no progress yet -> 0%, not completed', () => {
    expect(computeMetricProgress(10, 0)).toEqual({
      target: 10,
      current: 0,
      remaining: 10,
      percentage: 0,
      isCompleted: false,
    });
  });

  it('partial progress -> percentage/remaining computed, not completed', () => {
    expect(computeMetricProgress(10, 4)).toEqual({
      target: 10,
      current: 4,
      remaining: 6,
      percentage: 40,
      isCompleted: false,
    });
  });

  it('exact match -> 100%, completed, 0 remaining', () => {
    expect(computeMetricProgress(10, 10)).toEqual({
      target: 10,
      current: 10,
      remaining: 0,
      percentage: 100,
      isCompleted: true,
    });
  });

  it('target exceeded -> percentage reported uncapped, remaining floors at 0', () => {
    expect(computeMetricProgress(10, 15)).toEqual({
      target: 10,
      current: 15,
      remaining: 0,
      percentage: 150,
      isCompleted: true,
    });
  });

  it('fractional revenue values round to 2dp', () => {
    expect(computeMetricProgress(3, 1)).toEqual({
      target: 3,
      current: 1,
      remaining: 2,
      percentage: 33.33,
      isCompleted: false,
    });
  });
});
