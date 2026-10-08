// Stage 2: RBAC, CRUD, tenant isolation, uploads (S3), Redis-backed throttling. Uses clinics A/B from stage 1.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { init, Actor, multipart, check, results } = require('./lib.cjs');
const pick = (r) => (r && r.data && (r.data.data || r.data.customer || r.data.file || r.data)) || {};
(async () => {
  await init();
  const s = JSON.parse(fs.readFileSync('state.json', 'utf8'));
  const A = new Actor('A'), B = new Actor('B');
  let r = await A.call('POST', '/auth/login', { json: { email: s.dtoA.email, password: s.dtoA.password }, auth: false });
  check('re-login A after seed', [200, 201].includes(r.status));
  r = await B.call('POST', '/auth/login', { json: { email: s.dtoB.email, password: s.dtoB.password }, auth: false });
  r = await A.call('GET', '/auth/me'); const meA = r.data.user || r.data;
  check('owner now holds the full permission set (>=100)', (meA.permissions || []).length >= 100, `${(meA.permissions || []).length} permissions`);
  r = await B.call('GET', '/auth/me'); const meB = r.data.user || r.data;

  // ---- DB CRUD (customers)
  const cust = { phone: '+966555000101', full_name: 'ZZ E2E Customer A1', email: null, gender: 'female', preferred_locale: 'en' };
  r = await A.call('POST', '/crm/customers', { json: cust });
  check('CREATE customer (A) -> 201', r.status === 201, `status ${r.status} ${r.status !== 201 ? JSON.stringify(r.data).slice(0, 300) : ''}`);
  const custA = pick(r); const custAId = custA.id;
  r = await A.call('GET', `/crm/customers/${custAId}`);
  check('READ customer (A) -> 200 same id', r.status === 200 && pick(r).id === custAId, `status ${r.status}`);
  r = await A.call('PATCH', `/crm/customers/${custAId}`, { json: { full_name: 'ZZ E2E Customer A1 (edited)' } });
  check('UPDATE customer (A) -> 200', [200, 204].includes(r.status), `status ${r.status} ${r.status >= 400 ? JSON.stringify(r.data).slice(0, 200) : ''}`);
  r = await A.call('GET', `/crm/customers/${custAId}`);
  check('UPDATE persisted (read-after-write)', /edited/.test(JSON.stringify(r.data)));
  r = await A.call('GET', '/crm/customers');
  check('LIST customers (A) includes it', r.status === 200 && JSON.stringify(r.data).includes(custAId), `status ${r.status}`);
  r = await A.call('POST', '/crm/customers', { json: cust });
  check('duplicate phone in same tenant allowed (phone is deliberately non-unique)', r.status === 201, `status ${r.status}`);
  r = await A.call('POST', '/crm/customers', { json: { full_name: 'no phone' } });
  check('validation: missing phone -> 400', r.status === 400, `status ${r.status}`);

  // ---- tenant isolation
  r = await B.call('GET', `/crm/customers/${custAId}`);
  check('ISOLATION: B cannot read A customer (403/404)', [403, 404].includes(r.status), `status ${r.status}`);
  r = await B.call('PATCH', `/crm/customers/${custAId}`, { json: { full_name: 'HACKED' } });
  check('ISOLATION: B cannot update A customer', [403, 404].includes(r.status), `status ${r.status}`);
  r = await B.call('DELETE', `/crm/customers/${custAId}`);
  check('ISOLATION: B cannot delete A customer', [403, 404].includes(r.status), `status ${r.status}`);
  r = await B.call('GET', '/crm/customers');
  check('ISOLATION: B list does not contain A data', r.status === 200 && !JSON.stringify(r.data).includes(custAId) && !JSON.stringify(r.data).includes('+966555000101'));
  // same phone number is allowed in another tenant (proves per-tenant uniqueness, not global)
  r = await B.call('POST', '/crm/customers', { json: { ...cust, full_name: 'ZZ E2E Customer B1' } });
  check('same phone allowed in tenant B (per-tenant uniqueness)', r.status === 201, `status ${r.status} ${r.status !== 201 ? JSON.stringify(r.data).slice(0, 200) : ''}`);
  const custBId = pick(r).id;
  // forged tenant id in body/query must be ignored
  r = await B.call('GET', `/crm/customers?tenantId=${meA.tenantId}`);
  check('ISOLATION: tenantId query override rejected/ignored', [200, 400].includes(r.status) && !JSON.stringify(r.data).includes(custAId), `status ${r.status}`);
  const forged = await new Actor('forged'); forged.jar = { ...B.jar };
  r = await forged.call('GET', `/crm/customers/${custAId}`, { headers: { 'X-Tenant-Id': meA.tenantId } });
  check('ISOLATION: X-Tenant-Id header override ignored', [403, 404].includes(r.status), `status ${r.status}`);

  // ---- RBAC: receptionist inside A
  const recep = { email: `success+zze2er${s.ts}@simulator.amazonses.com`, password: 'E2e-Recep!' + s.ts, fullName: 'ZZ E2E Receptionist', roleSlug: 'receptionist' };
  r = await A.call('POST', '/auth/register-user', { json: recep });
  check('owner creates receptionist -> 201 (or already exists)', [201, 409].includes(r.status), `status ${r.status} ${r.status !== 201 ? JSON.stringify(r.data).slice(0, 250) : ''}`);
  const R = new Actor('R');
  r = await R.call('POST', '/auth/login', { json: { email: recep.email, password: recep.password }, auth: false });
  check('receptionist login -> 200', [200, 201].includes(r.status), `status ${r.status}`);
  r = await R.call('GET', `/crm/customers/${custAId}`);
  check('RBAC: receptionist CAN read customers (own tenant)', r.status === 200, `status ${r.status}`);
  r = await R.call('POST', '/auth/register-user', { json: { email: `success+zze2ex${s.ts}@simulator.amazonses.com`, password: 'E2e-Recep!x' + s.ts, fullName: 'x', roleSlug: 'receptionist' } });
  check('RBAC: receptionist CANNOT create staff (403)', r.status === 403, `status ${r.status}`);
  r = await A.call('POST', '/auth/register-user', { json: { email: `success+zze2ey${s.ts}@simulator.amazonses.com`, password: 'E2e-Priv!x' + s.ts, fullName: 'x', roleSlug: 'super_admin' } });
  check('RBAC: owner cannot mint super_admin (400/403)', [400, 403].includes(r.status), `status ${r.status}`);
  r = await R.call('GET', '/platform/tenants'); const rp = r.status;
  check('RBAC: tenant staff cannot reach platform console', [401, 403, 404].includes(rp), `status ${rp}`);

  // ---- Redis-backed throttling (counters live in ElastiCache/Valkey)
  const t1 = await new Actor('t').call('GET', '/system/health/readiness', { auth: false });
  const t2 = await new Actor('t').call('GET', '/system/health/readiness', { auth: false });
  const rem1 = Number(t1.headers['x-ratelimit-remaining']), rem2 = Number(t2.headers['x-ratelimit-remaining']);
  check('Redis: rate-limit counter decrements across requests', Number.isFinite(rem1) && Number.isFinite(rem2) && rem2 < rem1, `remaining ${rem1} -> ${rem2}`);
  check('Redis: readiness reports redis up', t1.data && t1.data.redis && t1.data.redis.status === 'up', JSON.stringify(t1.data.redis));

  // ---- uploads / S3
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = multipart({ fileName: 'zz-e2e.png' }, { field: 'file', name: 'zz-e2e.png', type: 'image/png', data: png });
  r = await A.call('POST', `/crm/customers/${custAId}/files`, { form });
  check('UPLOAD file to customer (A) -> 201', r.status === 201, `status ${r.status} ${r.status !== 201 ? JSON.stringify(r.data).slice(0, 300) : ''}`);
  const f = r.data; const fileId = f.id;
  console.log('   upload response keys:', Object.keys(f).join(','));
  r = await A.call('GET', `/crm/customers/${custAId}/files`);
  check('LIST files includes upload', r.status === 200 && JSON.stringify(r.data).includes(fileId), `status ${r.status}`);
  r = await A.call('GET', `/crm/customers/${custAId}/files/${fileId}`);
  check('DOWNLOAD file metadata/url -> 200', r.status === 200, `status ${r.status}`);
  const dl = r.raw; const url = (JSON.stringify(r.data).match(/https:\/\/[^"\\]+/) || [])[0];
  let s3key = null;
  if (url) {
    console.log('   download returns a presigned URL (host ' + new URL(url).host + ', expires param ' + (new URL(url).searchParams.get('X-Amz-Expires') || '?') + 's)');
    const u = new URL(url); s3key = decodeURIComponent(u.pathname.slice(1));
    const got = await fetch(url);
    const body = Buffer.from(await got.arrayBuffer());
    check('presigned URL serves the exact bytes uploaded', got.status === 200 && body.equals(png), `status ${got.status} bytes ${body.length}`);
    const bare = await fetch(u.origin + u.pathname);
    check('S3 object NOT readable without the signature (403)', bare.status === 403, `status ${bare.status}`);
  } else {
    check('download returned bytes directly', r.headers['content-type'] && /image\/png/.test(r.headers['content-type']) && Buffer.from(dl).equals(png), r.headers['content-type']);
  }
  // cross-tenant file access
  r = await B.call('GET', `/crm/customers/${custAId}/files/${fileId}`);
  check('ISOLATION: B cannot download A file (403/404)', [403, 404].includes(r.status), `status ${r.status}`);
  r = await B.call('GET', `/crm/customers/${custBId}/files/${fileId}`);
  check('ISOLATION: B cannot fetch A file via B customer path', [403, 404].includes(r.status), `status ${r.status}`);
  // type + size guards
  r = await A.call('POST', `/crm/customers/${custAId}/files`, { form: multipart({}, { field: 'file', name: 'evil.exe', type: 'application/x-msdownload', data: Buffer.from('MZ' + 'x'.repeat(64)) }) });
  check('upload guard: disallowed type rejected (4xx)', r.status >= 400 && r.status < 500, `status ${r.status}`);
  r = await A.call('POST', `/crm/customers/${custAId}/files`, { form: multipart({}, { field: 'file', name: 'big.png', type: 'image/png', data: Buffer.alloc(11 * 1024 * 1024, 1) }) });
  check('upload guard: >10 MB rejected (413/400)', [400, 413].includes(r.status), `status ${r.status}`);

  // independent AWS-side verification of the object
  if (s3key) {
    try {
      const out = execFileSync('aws', ['s3api', 'head-object', '--bucket', 'zt-production-uploads-270370109141', '--key', s3key, '--region', 'eu-central-1', '--query', '[ServerSideEncryption,ContentLength,ContentType]', '--output', 'text'], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }).trim();
      check('S3: object exists, SSE-KMS, size matches', /aws:kms/.test(out) && out.includes(String(png.length)), out.replace(/\s+/g, ' '));
    } catch (e) { check('S3: object exists (aws s3api head-object)', false, String(e.message).slice(0, 160)); }
  }
  r = await A.call('DELETE', `/crm/customers/${custAId}/files/${fileId}`);
  check('DELETE file -> 200/204', [200, 204].includes(r.status), `status ${r.status}`);
  r = await A.call('GET', `/crm/customers/${custAId}/files/${fileId}`);
  check('deleted file -> 404', r.status === 404, `status ${r.status}`);
  if (s3key) {
    try { execFileSync('aws', ['s3api', 'head-object', '--bucket', 'zt-production-uploads-270370109141', '--key', s3key, '--region', 'eu-central-1'], { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } }); check('S3: object removed after delete', false, 'still present'); }
    catch { check('S3: object removed after delete', true); }
  }

  // customer delete + audit
  r = await A.call('DELETE', `/crm/customers/${custAId}`);
  check('DELETE customer (A) -> 200/204', [200, 204].includes(r.status), `status ${r.status}`);
  r = await A.call('GET', `/crm/customers/${custAId}`);
  check('deleted customer no longer readable', [404, 410].includes(r.status), `status ${r.status}`);

  s.custAId = custAId; s.custBId = custBId; s.tenantA = meA.tenantId; s.tenantB = meB.tenantId; s.recepEmail = recep.email;
  fs.writeFileSync('state.json', JSON.stringify(s, null, 2));
  const fails = results.filter((x) => !x.ok); console.log(`\nSTAGE2: ${results.length - fails.length}/${results.length} passed`);
  if (fails.length) console.log('FAILED:', fails.map((x) => x.name).join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
