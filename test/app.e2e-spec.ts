import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// This harness boots bare AppModule — no api/v1 prefix, no main.ts raw
// Express handler — so it cannot exercise the real running root-route
// contract (that rewrite, including the global JWT guard, is Wave 7 /
// VAL-001'). It previously also carried the unmodified NestJS starter's
// '/ (GET)' -> 'Hello World!' test, which only ever passed here: that
// AppController/AppService pair was a second, dead root-identity
// registration alongside main.ts's real '/' handler (FND-005). It has been
// removed, along with that test.
describe('root route registration (FND-005)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('does not resolve "/" via a duplicate starter root-route registration', () => {
    return request(app.getHttpServer()).get('/').expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
