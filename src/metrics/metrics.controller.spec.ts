import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController (M14)', () => {
  it('writes the registry content type, disables caching, and sends the rendered body', async () => {
    const metrics = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      render: jest
        .fn()
        .mockResolvedValue(
          'bullmq_jobs_total{queue="x",status="completed"} 1\n',
        ),
    };
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    const controller = new MetricsController(
      metrics as unknown as MetricsService,
    );

    await controller.getMetrics(res as any);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      metrics.contentType,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.send).toHaveBeenCalledWith(
      'bullmq_jobs_total{queue="x",status="completed"} 1\n',
    );
  });
});
