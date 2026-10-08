// Stage 3: product onboarding flow — owner uploads required verification docs -> submits -> super-admin approves.
const fs = require('fs');
const { init, Actor, multipart, check, results } = require('./lib.cjs');
const pick = (r) => (r && r.data && (r.data.data || r.data)) || {};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  await init();
  const s = JSON.parse(fs.readFileSync('state.json', 'utf8'));
  const adm = JSON.parse(fs.readFileSync('admin.json', 'utf8').replace(/^﻿/, ''));
  const ADMIN = new Actor('ADMIN');
  let r = await ADMIN.call('POST', '/auth/login', { json: { email: adm.email, password: adm.password }, auth: false });
  check('super-admin login -> 200', [200, 201].includes(r.status), `status ${r.status} ${r.status >= 400 ? JSON.stringify(r.data).slice(0, 200) : ''}`);
  r = await ADMIN.call('GET', '/auth/me'); const me = r.data.user || r.data;
  check('super-admin has super_admin role, no tenant', (me.roles || []).includes('super_admin') && !me.tenantId, JSON.stringify({ roles: me.roles, tenantId: me.tenantId }));

  for (const tag of ['A', 'B']) {
    const O = new Actor(tag); const dto = s['dto' + tag];
    await O.call('POST', '/auth/login', { json: { email: dto.email, password: dto.password }, auth: false });
    const ids = [];
    for (const docType of ['commercial_registration', 'national_id', 'license']) {
      const up = await O.call('POST', '/uploads', { form: multipart({ docType }, { field: 'file', name: `${docType}.png`, type: 'image/png', data: png }) });
      const stored = pick(up);
      check(`[${tag}] upload ${docType} -> 201 (verification bucket path)`, up.status === 201, `status ${up.status} ${up.status !== 201 ? JSON.stringify(up.data).slice(0, 250) : 'keys=' + Object.keys(stored).join(',')}`);
      const d = await O.call('POST', '/verification-documents/me', { json: { docType, storageKey: stored.key || stored.storageKey, fileUrl: stored.url || stored.key } });
      check(`[${tag}] register doc ${docType} -> 201`, d.status === 201, `status ${d.status} ${d.status !== 201 ? JSON.stringify(d.data).slice(0, 250) : ''}`);
      ids.push(pick(d).id);
    }
    r = await O.call('POST', '/verification-documents/me/submit');
    check(`[${tag}] submit for review -> 200/201`, [200, 201].includes(r.status), `status ${r.status} ${JSON.stringify(r.data).slice(0, 220)}`);
    for (const id of ids) {
      r = await ADMIN.call('PATCH', `/verification-documents/${id}/review`, { json: { status: 'APPROVED', reviewNote: 'zz-e2e automated approval' } });
      check(`[${tag}] admin approves doc ${String(id).slice(0, 8)}`, [200, 201].includes(r.status), `status ${r.status} ${r.status >= 400 ? JSON.stringify(r.data).slice(0, 220) : ''}`);
    }
    r = await O.call('GET', '/crm/customers');
    check(`[${tag}] tenant now admitted (customers list != 403)`, r.status === 200, `status ${r.status} ${r.status !== 200 ? JSON.stringify(r.data).slice(0, 200) : ''}`);
  }
  fs.writeFileSync('state.json', JSON.stringify(s, null, 2));
  const fails = results.filter((x) => !x.ok); console.log(`\nSTAGE3: ${results.length - fails.length}/${results.length} passed`);
  if (fails.length) console.log('FAILED:', fails.map((x) => x.name).join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
