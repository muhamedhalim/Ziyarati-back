const fs=require('fs'); const {init,Actor}=require('./lib.cjs');
(async()=>{ await init(); const s=JSON.parse(fs.readFileSync('state.json','utf8')); const adm=JSON.parse(fs.readFileSync('admin.json','utf8').replace(/^\uFEFF/,''));
 const AD=new Actor('AD'); await AD.call('POST','/auth/login',{json:{email:adm.email,password:adm.password},auth:false});
 for (const [tag,tid] of [['A',s.tenantA],['B',s.tenantB]]) {
   const g=await AD.call('GET',`/tenants/${tid}`); const slug=(g.data.data||g.data).slug;
   if (!/^zz-e2e-[ab]-/.test(slug)) { console.log('REFUSING: unexpected slug',slug); process.exit(2); }
   const r=await AD.call('POST',`/tenants/${tid}/suspend`,{json:{}});
   console.log(tag,tid,slug,'suspend ->',r.status,JSON.stringify(r.data).slice(0,160));
 }
})();
