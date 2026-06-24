import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateReviewDto } from './create-review.dto';

const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(CreateReviewDto, payload));

describe('CreateReviewDto validation', () => {
  it('accepts a valid rating with an optional comment', async () => {
    expect(await errorsFor({ rating: 5, comment: 'great' })).toHaveLength(0);
  });

  it('accepts a rating with no comment', async () => {
    expect(await errorsFor({ rating: 3 })).toHaveLength(0);
  });

  it('rejects a rating below 1', async () => {
    const errors = await errorsFor({ rating: 0 });
    expect(errors.some((e) => e.property === 'rating')).toBe(true);
  });

  it('rejects a rating above 5', async () => {
    const errors = await errorsFor({ rating: 6 });
    expect(errors.some((e) => e.property === 'rating')).toBe(true);
  });

  it('rejects a non-integer rating', async () => {
    const errors = await errorsFor({ rating: 4.5 });
    expect(errors.some((e) => e.property === 'rating')).toBe(true);
  });

  it('rejects a comment over the max length', async () => {
    const errors = await errorsFor({ rating: 5, comment: 'x'.repeat(4001) });
    expect(errors.some((e) => e.property === 'comment')).toBe(true);
  });
});
