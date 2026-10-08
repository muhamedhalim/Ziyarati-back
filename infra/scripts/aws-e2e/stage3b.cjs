const fs=require('fs'); const {init,Actor,check,results}=require('./lib.cjs');
(async()=>{ await init(); const s=JSON.parse(fs.readFileSync('state.json','utf8')); const adm=JSON.parse(fs.readFileSync('admin.json','utf8').replace(/^\uFEFF/,''));
 const ADMIN=new Actor('ADMIN'); await ADMIN.call('POST','/auth/login',{json:{email:adm.email,password:adm.password},auth:false});
 for (const tag of ['A','B']) {
   const O=new Actor(tag); await O.call('POST','/auth/login',{json:{email:s['dto'+tag].email,password:s['dto'+tag].password},auth:false});
   const me=(await O.call('GET','/auth/me')).data; const tid=(me.user||me).tenantId;
   let r=await ADMIN.call('POST',`/tenants/${tid}/approve`,{json:{}});
   check(`[${tag}] super-admin approves clinic`,[200,201].includes(r.status),`status ${r.status} ${JSON.stringify(r.data).slice(0,250)}`);
   r=await O.call('GET','/crm/customers');
   check(`[${tag}] tenant admitted (customers list -> 200)`,r.status===200,`status ${r.status} ${r.status!==200?JSON.stringify(r.data).slice(0,200):''}`);
 }
 const f=results.filter(x=>!x.ok).length; console.log(`STAGE3b: ${results.length-f}/${results.length}`); process.exit(f?1:0);
})();
