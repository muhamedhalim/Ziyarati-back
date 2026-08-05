import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * BEO-001 (REQ-AUTH-003): public patient self-registration had a backend
 * route with no confirmed consumer anywhere — no frontend page, no other
 * backend route ever accepts the `type: "patient"` token it issues, no
 * integration-API client. Resolved by retirement: the route is removed
 * (closing the unauthenticated, CSRF-exempt attack surface); PatientService/
 * the Patient entity/table are left intact and reversible.
 */
describe('auth — patient self-registration retirement (BEO-001)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('no longer exposes an unauthenticated route that creates patient accounts', () => {
    return request(app.getHttpServer())
      .post('/auth/register-patient')
      .send({
        email: `beo-001-${Date.now()}@example.com`,
        password: 'SomePass123!',
        fullName: 'Test Patient',
      })
      .expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
