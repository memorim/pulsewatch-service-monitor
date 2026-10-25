import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import http from 'node:http';

export const defaultHosts=['memorim.github.io','memorim-flowboard-live.amusedcorgi34.chatgpt.site'];
export const allowedHosts=()=>new Set((process.env.MONITOR_ALLOWED_HOSTS||defaultHosts.join(',')).split(',').map(h=>h.trim().toLowerCase()).filter(Boolean));
export function targetUrl(value,hosts=allowedHosts()){
 const url=new URL(value.includes('://')?value:'https://'+value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.port&&url.port!==(url.protocol==='https:'?'443':'80'))||!hosts.has(url.hostname.toLowerCase()))throw new Error('Разрешены HTTP/HTTPS-адреса настроенных владельцем доменов, без пароля и параметров');
 return url;
}
export function publicAddress(address){
 if(isIP(address)===6){
  const normalized=new URL('https://['+address+']/').hostname.slice(1,-1),parts=normalized.split(':'),first=parseInt(parts[0],16),second=parseInt(parts[1]||'0',16);
  // Conservative policy: transition, documentation and IETF protocol-assignment ranges are not monitoring targets.
  return first>=0x2000&&first<0x4000&&!(first===0x2001&&(second<0x0200||second===0x0db8))&&first!==0x2002&&!(first===0x3fff&&second<0x1000);
 }
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0&&(c===0||c===2))||(b===88&&c===99)))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
}
export async function probe(value,{hosts=allowedHosts(),resolve=lookup,request,signal=new AbortController().signal}={}){
 let url=targetUrl(value,hosts);const started=performance.now();
 for(let redirect=0;redirect<=3;redirect++){
  signal.throwIfAborted();
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(5000)]);let abort;let addresses;
  try{
   const cancelled=new Promise((_,reject)=>{abort=()=>reject(deadline.reason);deadline.addEventListener('abort',abort,{once:true});if(deadline.aborted)abort();});
   addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),cancelled]);
  }finally{deadline.removeEventListener('abort',abort);}
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('non_public_address');
  const selected=addresses[0];
  const response=await new Promise((resolve,reject)=>{
   const send=request||(url.protocol==='https:'?https.request:http.request);const req=send(url,{method:'GET',agent:false,family:selected.family,autoSelectFamily:false,lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family),signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),headers:{'User-Agent':'Pulsewatch/2.0','Accept':'*/*'}},res=>{const result={code:res.statusCode,location:res.headers.location};res.destroy();resolve(result);});req.on('error',reject);req.end();
  });
  if(response.code>=300&&response.code<400&&response.location){const next=targetUrl(new URL(response.location,url).href,hosts);if(url.protocol==='https:'&&next.protocol!=='https:')throw new Error('insecure_redirect');url=next;continue;}
  return {ok:response.code>=200&&response.code<400,statusCode:response.code,responseMs:Math.round(performance.now()-started),error:response.code>=400?'http_'+response.code:null};
 }
 throw new Error('redirect_limit');
}
export async function checkMonitor(db,monitor,{check=probe,now=new Date().toISOString(),signal}={}){
 let result;try{result=await check(monitor.url,{signal});}catch(error){if(signal?.aborted)throw error;result={ok:false,statusCode:null,responseMs:null,error:error?.message==='non_public_address'?'non_public_address':'network_error'};}
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
 if(!Number.isFinite(intervalMs)||intervalMs<5000||intervalMs>86400000||!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365)throw new Error('Invalid monitoring schedule');
 let running=false,stopped=false,started=false,timer,active=Promise.resolve(false);const controller=new AbortController();
 const run=()=>{
  if(running||stopped)return Promise.resolve(false);running=true;
  active=(async()=>{try{
   // ponytail: sequential probes bound outbound concurrency to one; use a bounded pool if target count grows beyond 30.
   for(const monitor of db.prepare('SELECT * FROM monitors WHERE enabled=1 ORDER BY id').all()){if(stopped)break;await checkMonitor(db,monitor,{check,signal:controller.signal});}
   db.prepare('DELETE FROM checks WHERE checked_at<?').run(new Date(Date.now()-retentionDays*86400000).toISOString());return true;
  }catch(error){if(!controller.signal.aborted)throw error;return false;}finally{running=false;}})();return active;
 };
 const start=()=>{if(started||stopped)return;started=true;const tick=async()=>{try{await run();}catch{console.error(JSON.stringify({event:'monitor_cycle',status:'failed'}));}if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}};void tick();};
 return {run,start,stop:async()=>{stopped=true;clearTimeout(timer);controller.abort();await active;},get running(){return running;}};
}
