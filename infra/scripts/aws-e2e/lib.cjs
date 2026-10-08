// Tiny HTTP/WS test client that pins api.ziyaratech.com to the ALB IP in-process (no DNS/hosts changes).
const https = require('https');
const dns = require('dns');
const HOST = 'api.ziyaratech.com';
const ALB = 'zt-production-api-1461747647.eu-central-1.elb.amazonaws.com';
let IP = null;

async function init() {
  const a = await dns.promises.lookup(ALB,{family:4,all:true});
  IP = a[0].address;
  return IP;
}
// lookup override works for both https.request and socket.io-client/ws agents
const lookup = (hostname, opts, cb) => {
  const addr = hostname === HOST ? IP : null;
  if (!addr) return dns.lookup(hostname, opts, cb);
  if (opts && opts.all) return cb(null, [{ address: addr, family: 4 }]);
  return cb(null, addr, 4);
};
const agent = () => new https.Agent({ lookup, keepAlive: false });

class Actor {
  constructor(name) { this.name = name; this.jar = {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(setCookie) {
    for (const c of setCookie || []) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (/^AWSALB/.test(k)) continue;
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') delete this.jar[k]; else this.jar[k] = v;
    }
  }
  async call(method, path, { json, form, headers = {}, auth = true, origin = 'https://www.ziyaratech.com' } = {}) {
    const h = { Host: HOST, Origin: origin, Accept: 'application/json', ...headers };
    let body = null;
    if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); h['Content-Type'] = 'application/json'; }
    if (form) { body = form.buffer; h['Content-Type'] = `multipart/form-data; boundary=${form.boundary}`; }
    if (body) h['Content-Length'] = body.length;
    if (auth) {
      const ch = this.cookieHeader(); if (ch) h.Cookie = ch;
      if (this.jar.csrf_token && method !== 'GET') h['X-CSRF-Token'] = this.jar.csrf_token;
    }
    return new Promise((resolve, reject) => {
      const req = https.request({ host: HOST, port: 443, path: '/api/v1' + path, method, headers: h, agent: agent(), lookup, servername: HOST, timeout: 30000 }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          this.absorb(res.headers['set-cookie']);
          const raw = Buffer.concat(chunks);
          let data = null; const t = raw.toString('utf8');
          try { data = JSON.parse(t); } catch { data = t; }
          resolve({ status: res.statusCode, headers: res.headers, data, raw });
        });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
      if (body) req.write(body); req.end();
    });
  }
}

function multipart(fields, file) {
  const boundary = '----zt' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'file'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, buffer: Buffer.concat(parts) };
}

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return ok; }
module.exports = { init, Actor, multipart, check, results, lookup, agent, HOST, get IP() { return IP; } };
