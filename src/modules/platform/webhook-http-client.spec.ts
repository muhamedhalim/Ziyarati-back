import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { deliverWebhookRequest } from './webhook-http-client';
import { WEBHOOK_HEADER, computeWebhookSignature, verifyWebhookSignature } from './webhook.constants';

// This suite intentionally targets a REAL local HTTP server (127.0.0.1) — the
// one thing that must be bypassed to make that possible is the SSRF guard's
// resolution step (127.0.0.1 is, correctly, blocked by policy — see
// webhook-url-guard.spec.ts, which tests that blocking exhaustively and for
// real). Here we mock ONLY `resolveSafeWebhookTarget` to pin to whatever
// literal host the test target URL already carries, so every other layer
// (header/body construction, signing, the raw http.request socket, response
// reading, redirect handling, timeout, status classification) runs for real
// against a real listening server.
jest.mock('./webhook-url-guard', () => ({
  ...jest.requireActual('./webhook-url-guard'),
  resolveSafeWebhookTarget: jest.fn(async (url: URL) => ({
    address: url.hostname,
    family: 4 as const,
  })),
}));

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, captured: CapturedRequest) => void,
): Promise<{ server: http.Server; port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const captured: CapturedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(captured);
        handler(req, res, captured);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, requests });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('deliverWebhookRequest — real local HTTP receiver', () => {
  const SECRET = 'whsec_test_secret_value';

  it('delivers the exact body with correct id/event/timestamp/signature headers, verifiable by the receiver', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    try {
      const body = JSON.stringify({ appointmentId: 'a1', startAt: '2026-08-01T10:00:00.000Z' });
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const signature = computeWebhookSignature(SECRET, timestampSeconds, body);
      const headers = {
        [WEBHOOK_HEADER.ID]: 'delivery-123',
        [WEBHOOK_HEADER.EVENT]: 'appointment.created',
        [WEBHOOK_HEADER.TIMESTAMP]: String(timestampSeconds),
        [WEBHOOK_HEADER.SIGNATURE]: signature,
      };

      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, body, headers, 2000);

      expect(result).toEqual({ ok: true, transient: false, httpStatus: 200, bodyPreview: 'ok' });
      expect(requests).toHaveLength(1);
      const received = requests[0];
      expect(received.method).toBe('POST');
      expect(received.url).toBe('/webhook');
      expect(received.body).toBe(body);
      expect(received.headers['x-webhook-id']).toBe('delivery-123');
      expect(received.headers['x-webhook-event']).toBe('appointment.created');
      expect(received.headers['x-webhook-timestamp']).toBe(String(timestampSeconds));
      expect(received.headers['x-webhook-signature']).toBe(signature);
      expect(received.headers['content-type']).toBe('application/json');

      // The receiver independently re-derives and verifies the signature —
      // proving the HMAC scheme works end-to-end, not just in isolation.
      const verified = verifyWebhookSignature(
        SECRET,
        Number(received.headers['x-webhook-timestamp']),
        received.body,
        received.headers['x-webhook-signature'] as string,
      );
      expect(verified).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('never sends an Authorization header or the raw secret in cleartext anywhere in the request', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    try {
      const body = JSON.stringify({ paymentId: 'p1' });
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const headers = {
        [WEBHOOK_HEADER.ID]: 'd1',
        [WEBHOOK_HEADER.EVENT]: 'payment.succeeded',
        [WEBHOOK_HEADER.TIMESTAMP]: String(timestampSeconds),
        [WEBHOOK_HEADER.SIGNATURE]: computeWebhookSignature(SECRET, timestampSeconds, body),
      };
      await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, body, headers, 2000);

      const received = requests[0];
      expect(received.headers.authorization).toBeUndefined();
      expect(JSON.stringify(received.headers)).not.toContain(SECRET);
      expect(received.body).not.toContain(SECRET);
    } finally {
      await closeServer(server);
    }
  });

  it('classifies a permanent 4xx as ok:false, transient:false', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    try {
      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 2000);
      expect(result).toMatchObject({ ok: false, transient: false, httpStatus: 404, bodyPreview: 'not found' });
    } finally {
      await closeServer(server);
    }
  });

  it('classifies a 5xx as retryable (transient:true)', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    try {
      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 2000);
      expect(result).toMatchObject({ ok: false, transient: true, httpStatus: 500 });
    } finally {
      await closeServer(server);
    }
  });

  it('classifies 408/429 as retryable', async () => {
    for (const status of [408, 429]) {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(status);
        res.end();
      });
      try {
        const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 2000);
        expect(result).toMatchObject({ ok: false, transient: true, httpStatus: status });
      } finally {
        await closeServer(server);
      }
    }
  });

  it('classifies a timeout as transient with the documented error message', async () => {
    const { server, port } = await startServer(() => {
      // Never responds at all — the client's own timeout must fire.
    });
    try {
      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 150);
      expect(result).toMatchObject({ ok: false, transient: true, error: 'Delivery timed out' });
    } finally {
      await closeServer(server);
    }
  }, 10_000);

  it('classifies a connection failure (nothing listening) as transient', async () => {
    // Port 1 is never listened on for this test process — connection refused.
    const result = await deliverWebhookRequest('http://127.0.0.1:1/webhook', '{}', {}, 2000);
    expect(result.ok).toBe(false);
    expect(result.transient).toBe(true);
  });

  it('never follows a redirect — a 3xx is classified as permanent and the Location target is never requested', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    try {
      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 2000);
      expect(result).toMatchObject({ ok: false, transient: false, httpStatus: 302 });
      // Exactly the one request we sent — nothing chased the redirect.
      expect(requests).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it('truncates the stored response preview to ~500 characters', async () => {
    const bigBody = 'x'.repeat(100_000);
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(bigBody);
    });
    try {
      const result = await deliverWebhookRequest(`http://127.0.0.1:${port}/webhook`, '{}', {}, 2000);
      expect(result.ok).toBe(true);
      expect(result.bodyPreview!.length).toBeLessThanOrEqual(500);
    } finally {
      await closeServer(server);
    }
  });
});
