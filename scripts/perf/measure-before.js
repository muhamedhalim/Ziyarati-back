const http = require('http');
const fs = require('fs');

const cookies = fs.readFileSync('cookies-before.txt', 'utf8')
  .split(/\r?\n/)
  .map(l => l.startsWith('#HttpOnly_') ? l.slice('#HttpOnly_'.length) : l)
  .filter(l => l && !l.startsWith('#'))
  .map(l => l.split('\t'))
  .filter(p => p.length >= 7)
  .map(p => `${p[5]}=${p[6].trim()}`)
  .join('; ');

function timeRequest(path) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3001,
      path,
      method: 'GET',
      headers: { Cookie: cookies },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const end = process.hrtime.bigint();
        resolve({ ms: Number(end - start) / 1e6, status: res.statusCode, bytes: Buffer.byteLength(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function sample(path, n) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await timeRequest(path));
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => ms[Math.floor(q * (ms.length - 1))];
  return {
    path,
    n,
    statuses: [...new Set(results.map((r) => r.status))],
    p50: p(0.5).toFixed(2),
    p95: p(0.95).toFixed(2),
    p99: p(0.99).toFixed(2),
    min: ms[0].toFixed(2),
    max: ms[ms.length - 1].toFixed(2),
    avg: (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2),
  };
}

(async () => {
  const routes = [
    '/api/v1/system/health/liveness',
    '/api/v1/auth/me',
    '/api/v1/branches',
  ];
  const out = {};
  for (const r of routes) {
    // warm-up
    await timeRequest(r);
    out[r] = await sample(r, 30);
    console.log(JSON.stringify(out[r]));
  }
  fs.writeFileSync('before-client-latency.json', JSON.stringify(out, null, 2));
})();
