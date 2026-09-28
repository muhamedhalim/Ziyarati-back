import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateBranchDto } from './create-branch.dto';
import { UpdateBranchDto } from './update-branch.dto';

async function check<T extends object>(cls: new () => T, body: object) {
  const dto = plainToInstance(cls, body, { enableImplicitConversion: true });
  return { dto, errors: await validate(dto as object) };
}

describe('Branch DTO — city validation', () => {
  it('trims and collapses whitespace in city', async () => {
    const { dto, errors } = await check(CreateBranchDto, {
      name: 'Main',
      city: '  Nasr    City  ',
    });
    expect(errors).toEqual([]);
    expect(dto.city).toBe('Nasr City');
  });

  it.each(['Riyadh', 'الرياض', 'Jeddah', 'مدينة نصر'])(
    'accepts %s (Arabic and English)',
    async (city) => {
      const { errors } = await check(CreateBranchDto, { name: 'Main', city });
      expect(errors).toEqual([]);
    },
  );

  it.each(['', '   '])(
    'rejects an empty/whitespace city (%j)',
    async (city) => {
      const { errors } = await check(CreateBranchDto, { name: 'Main', city });
      expect(errors.map((e) => e.property)).toContain('city');
    },
  );

  it('rejects a city over 100 characters (the cities.name_* column width)', async () => {
    const { errors } = await check(CreateBranchDto, {
      name: 'Main',
      city: 'x'.repeat(101),
    });
    expect(errors.map((e) => e.property)).toContain('city');
  });

  it('city stays optional on create (clinics without a city remain valid) and on update', async () => {
    expect((await check(CreateBranchDto, { name: 'Main' })).errors).toEqual([]);
    expect((await check(UpdateBranchDto, { isActive: false })).errors).toEqual(
      [],
    );
  });

  it('update rejects a blank city rather than clearing it', async () => {
    const { errors } = await check(UpdateBranchDto, { city: '  ' });
    expect(errors.map((e) => e.property)).toContain('city');
  });
});
