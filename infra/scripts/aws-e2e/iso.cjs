const fs=require('fs'); const {init,Actor,check,results}=require('./lib.cjs');
const rows=(r)=>{const d=r.data;const a=Array.isArray(d)?d:(d.data||d.items||[]);return a};
(async()=>{ await init(); const s=JSON.parse(fs.readFileSync('state.json','utf8')); const A=new Actor('A'),B=new Actor('B');
 await A.call('POST','/auth/login',{json:{email:s.dtoA.email,password:s.dtoA.password},auth:false});
 await B.call('POST','/auth/login',{json:{email:s.dtoB.email,password:s.dtoB.password},auth:false});
 const la=rows(await A.call('GET','/crm/customers?limit=100')), lb=rows(await B.call('GET','/crm/customers?limit=100'));
 const ia=new Set(la.map(x=>x.id)), ib=new Set(lb.map(x=>x.id));
 console.log('A customers:',ia.size,' B customers:',ib.size);
 check('ISOLATION: customer ID sets of A and B are disjoint',ia.size>0&&ib.size>0&&![...ia].some(i=>ib.has(i)));
 check('ISOLATION: every row B sees belongs to tenant B',lb.every(x=>!x.tenant||x.tenant.id===s.tenantB||x.tenantId===s.tenantB));
 check("ISOLATION: no 'A1/dbg' names leak into B's list",!lb.some(x=>/A1|dbg/.test(x.full_name||'')));
 // search endpoint must not cross tenants either
 const sr=await B.call('GET','/crm/customers/search?q=ZZ%20dbg'); 
 check('ISOLATION: B search for an A-only name returns nothing',[200,404].includes(sr.status)&&!/ZZ dbg/.test(JSON.stringify(sr.data)),`status ${sr.status}`);
 const f=results.filter(x=>!x.ok).length; console.log(`ISO: ${results.length-f}/${results.length}`); process.exit(f?1:0);
})();
