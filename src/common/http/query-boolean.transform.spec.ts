import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsOptional, validateSync } from 'class-validator';

import { QueryBoolean } from './query-boolean.transform';

class Probe {
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  flag?: boolean;
}

const parse = (flag: unknown) =>
  plainToInstance(Probe, { flag }, { enableImplicitConversion: true });

describe('QueryBoolean', () => {
  it.each([
    ['true', true],
    [true, true],
    ['false', false],
    [false, false],
  ])('parses %p as %p', (input, expected) => {
    const probe = parse(input);
    expect(probe.flag).toBe(expected);
    expect(validateSync(probe)).toHaveLength(0);
  });

  it("'false' is FALSE — the bug that Type(() => Boolean) had", () => {
    expect(parse('false').flag).toBe(false);
  });

  it('leaves garbage untouched so @IsBoolean rejects it instead of coercing it', () => {
    const probe = parse('maybe');
    expect(probe.flag).toBe('maybe');
    expect(validateSync(probe)).toHaveLength(1);
  });

  it('an absent value stays undefined and is valid (IsOptional)', () => {
    const probe = plainToInstance(Probe, {});
    expect(probe.flag).toBeUndefined();
    expect(validateSync(probe)).toHaveLength(0);
  });
});
