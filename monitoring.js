import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';

export const defaultHosts=['memorim.github.io','memorim-flowboard-live.amusedcorgi34.chatgpt.site'];
export const allowedHosts=()=>new Set((process.env.MONITOR_ALLOWED_HOSTS||defaultHosts.join(',')).split(',').map(h=>h.trim().toLowerCase()).filter(Boolean));
export function targetUrl(value,hosts=allowedHosts()){
 const url=new URL(value.includes('://')?value:'https://'+value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||(url.port&&url.port!=='443')||!hosts.has(url.hostname.toLowerCase()))throw new Error('Разрешены HTTPS-адреса настроенных владельцем доменов, без пароля и параметров');
 return url;
}
export function publicAddress(address){
 if(isIP(address)===6)return /^[23]/i.test(address)&&!/^2001:(?:0:|db8:)/i.test(address)&&!/^2002:/i.test(address);
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
}
export async function probe(value,{hosts=allowedHosts(),resolve=lookup,request=https.request}={}){
 let url=targetUrl(value,hosts);const started=performance.now();
 for(let redirect=0;redirect<=3;redirect++){
  const addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('dns_timeout')),5000);t.unref();})]);
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('non_public_address');
  const selected=addresses[0];
  const response=await new Promise((resolve,reject)=>{
   const req=request(url,{method:'GET',agent:false,family:selected.family,autoSelectFamily:false,lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family),signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Pulsewatch/2.0','Accept':'*/*'}},res=>{const result={code:res.statusCode,location:res.headers.location};res.destroy();resolve(result);});req.on('error',reject);req.end();
  });
  if(response.code>=300&&response.code<400&&response.location){url=targetUrl(new URL(response.location,url).href,hosts);continue;}
  return {ok:response.code>=200&&response.code<400,statusCode:response.code,responseMs:Math.round(performance.now()-started),error:response.code>=400?'http_'+response.code:null};
 }
 throw new Error('redirect_limit');
}
export async function checkMonitor(db,monitor,{check=probe,now=new Date().toISOString()}={}){
 let result;try{result=await check(monitor.url);}catch(error){result={ok:false,statusCode:null,responseMs:null,error:error?.message==='non_public_address'?'non_public_address':'network_error'};}
 const state=result.ok?(result.responseMs>1000?'degraded':'operational'):'down';
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO checks(monitor_id,checked_at,ok,status_code,response_ms,error) VALUES(?,?,?,?,?,?)').run(monitor.id,now,Number(result.ok),result.statusCode,result.responseMs,result.error);
  db.prepare("UPDATE monitors SET status=?,response_ms=?,last_checked=?,status_source='probe' WHERE id=?").run(state,result.responseMs,now,monitor.id);
  const recent=db.prepare('SELECT ok FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 2').all(monitor.id);
  if(!result.ok&&recent.length===2&&recent.every(r=>!r.ok))db.prepare("INSERT INTO incidents(title,detail,severity,status,started_at,monitor_id) SELECT ?,?,'major','investigating',?,? WHERE NOT EXISTS(SELECT 1 FROM incidents WHERE monitor_id=? AND status!='resolved')").run('Сервис недоступен: '+monitor.name,'Две последовательные проверки завершились ошибкой.',now,monitor.id,monitor.id);
  if(result.ok)db.prepare("UPDATE incidents SET status='resolved',resolved_at=? WHERE monitor_id=? AND status!='resolved'").run(now,monitor.id);
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 return result;
}
export function monitorRunner(db,{check=probe,intervalMs=60000,retentionDays=30}={}){
 if(!Number.isFinite(intervalMs)||intervalMs<1000||!Number.isInteger(retentionDays)||retentionDays<1)throw new Error('Invalid monitoring schedule');
 let running=false,stopped=false,timer;
 const run=async()=>{
  if(running||stopped)return false;running=true;
  try{
   // ponytail: sequential probes bound outbound concurrency to one; use a bounded pool if target count grows beyond 30.
   for(const monitor of db.prepare('SELECT * FROM monitors WHERE enabled=1 ORDER BY id').all()){if(stopped)break;await checkMonitor(db,monitor,{check});}
   db.prepare('DELETE FROM checks WHERE checked_at<?').run(new Date(Date.now()-retentionDays*86400000).toISOString());return true;
  }finally{running=false;}
 };
 const start=()=>{const tick=async()=>{try{await run();}catch{console.error(JSON.stringify({event:'monitor_cycle',status:'failed'}));}if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}};void tick();};
 return {run,start,stop:()=>{stopped=true;clearTimeout(timer);},get running(){return running;}};
}
