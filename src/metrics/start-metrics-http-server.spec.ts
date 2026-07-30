import { request } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';

import { startMetricsHttpServer } from './start-metrics-http-server';
import { MetricsService } from './metrics.service';

function buildConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startMetricsHttpServer (M14, worker process)', () => {
  it('serves the rendered registry on GET /metrics when no token is configured (dev)', async () => {
    const metrics = new MetricsService();
    metrics.recordJobEvent('notifications', 'completed');
    const config = buildConfig({
      NODE_ENV: 'development',
      WORKER_METRICS_PORT: '0',
    });
    const server = startMetricsHttpServer(config, metrics);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bullmq_jobs_total');

    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 404 for any other path', async () => {
    const metrics = new MetricsService();
    const config = buildConfig({
      NODE_ENV: 'development',
      WORKER_METRICS_PORT: '0',
    });
    const server = startMetricsHttpServer(config, metrics);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/not-metrics');
    expect(res.status).toBe(404);

    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects with 401 in production when METRICS_TOKEN is unset', async () => {
    const metrics = new MetricsService();
    const config = buildConfig({
      NODE_ENV: 'production',
      WORKER_METRICS_PORT: '0',
    });
    const server = startMetricsHttpServer(config, metrics);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    expect(res.status).toBe(401);

    await new Promise((resolve) => server.close(resolve));
  });

  it('enforces the bearer token when one is configured', async () => {
    const metrics = new MetricsService();
    const config = buildConfig({
      NODE_ENV: 'production',
      METRICS_TOKEN: 'secret-1',
      WORKER_METRICS_PORT: '0',
    });
    const server = startMetricsHttpServer(config, metrics);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const unauthorized = await get(port, '/metrics');
    expect(unauthorized.status).toBe(401);

    const authorized = await get(port, '/metrics', {
      authorization: 'Bearer secret-1',
    });
    expect(authorized.status).toBe(200);

    await new Promise((resolve) => server.close(resolve));
  });
});
