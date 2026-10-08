const fs=require('fs'),https=require('https'); const {init,Actor,agent,lookup,check,results,HOST}=require('./lib.cjs');
function raw(path,{cookie,origin='https://www.ziyaratech.com',method='GET',body}={}){return new Promise((res,rej)=>{const h={Host:HOST,Origin:origin};if(cookie)h.Cookie=cookie;if(body){h['Content-Type']='text/plain;charset=UTF-8';h['Content-Length']=Buffer.byteLength(body)}
 const r=https.request({host:HOST,port:443,path,method,headers:h,agent:agent(),lookup,servername:HOST,timeout:20000},x=>{const c=[];x.on('data',d=>c.push(d));x.on('end',()=>res({status:x.statusCode,headers:x.headers,text:Buffer.concat(c).toString()}))});r.on('error',rej);if(body)r.write(body);r.end()})}
(async()=>{ await init(); const s=JSON.parse(fs.readFileSync('state.json','utf8')); const B=new Actor('B');
 await B.call('POST','/auth/login',{json:{email:s.dtoB.email,password:s.dtoB.password},auth:false});
 const ck=['access_token','refresh_token','csrf_token'].map(k=>`${k}=${B.jar[k]}`).join('; ');
 let r=await raw('/socket.io/?EIO=4&transport=polling&t=1',{cookie:ck});
 const m=r.text.match(/\{.*\}/); const sid=m&&JSON.parse(m[0]).sid;
 check('polling handshake (allowed origin) -> 200 + sid',r.status===200&&!!sid,`status ${r.status}`);
 const alb=(r.headers['set-cookie']||[]).map(c=>c.split(';')[0]).filter(c=>/^AWSALB/.test(c)).join('; ');
 check('ALB stickiness cookie issued for polling session',alb.length>0);
 // namespace connect over polling (POST "40/ai,") then poll for the ai:connected packet — must hit the SAME task
 const c2=[ck,alb].filter(Boolean).join('; ');
 r=await raw(`/socket.io/?EIO=4&transport=polling&sid=${sid}`,{cookie:c2,method:'POST',body:'40/ai,'});
 check('polling POST namespace connect -> 200 ok',r.status===200&&/ok/.test(r.text),`status ${r.status} ${r.text.slice(0,40)}`);
 await new Promise(x=>setTimeout(x,1500));
 r=await raw(`/socket.io/?EIO=4&transport=polling&sid=${sid}`,{cookie:c2});
 check('polling GET returns ai:connected for tenant B (same task via stickiness)',r.status===200&&r.text.includes('ai:connected')&&r.text.includes(s.tenantB),`status ${r.status} ${r.text.slice(0,160)}`);
 r=await raw('/socket.io/?EIO=4&transport=polling&t=2',{cookie:ck,origin:'https://evil.example'});
 check('foreign Origin on polling -> 403 (CORS/origin policy at the API)',r.status===403,`status ${r.status}`);
 const f=results.filter(x=>!x.ok).length; console.log(`STAGE4b: ${results.length-f}/${results.length}`); process.exit(f?1:0);
})();
