import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
process.env.NODE_ENV='test';
const {createDb}=await import('../server.js');
const {publicAddress,monitorRunner,probe}=await import('../monitoring.js');

test('special-purpose address checks are independent of IPv6 spelling',()=>{
 for(const ip of ['2001:0db8::1','2001:0000::1','2001::1','2001:2::1','192.0.2.1','192.88.99.1','3fff::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('2001:4860:4860::8888'),true);
});

test('HTTP checks pin DNS too and HTTPS redirects cannot downgrade the connection',async()=>{
 const resolve=async()=>[{address:'8.8.8.8',family:4}];let calls=0;
 const request=(url,options,callback)=>{
  calls++;options.lookup('ignored',{},(_error,address)=>assert.equal(address,'8.8.8.8'));
  const req=new EventEmitter();req.end=()=>callback({statusCode:url.protocol==='http:'?200:302,headers:{location:'http://memorim.github.io/'},destroy(){}});return req;
 };
 assert.equal((await probe('http://memorim.github.io/',{resolve,request})).ok,true);
 await assert.rejects(()=>probe('https://memorim.github.io/',{resolve,request}),/insecure_redirect/);assert.equal(calls,2);
});

test('DNS lookup can be cancelled even when the resolver never answers',async()=>{
 const controller=new AbortController();const pending=probe('https://memorim.github.io/',{signal:controller.signal,resolve:()=>new Promise(()=>{}),request:()=>{throw new Error('must not connect');}});
 controller.abort(new Error('shutdown fixture'));await assert.rejects(()=>pending,/shutdown fixture/);
});

test('scheduler rejects timeout overflow and drains an aborted probe without recording a failure',async()=>{
 const db=createDb(':memory:');try{
  assert.throws(()=>monitorRunner(db,{intervalMs:2**32}));
  let begun;const started=new Promise(resolve=>begun=resolve);
  const runner=monitorRunner(db,{check:async(_url,{signal})=>{begun();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const active=runner.run();await started;
  await Promise.race([runner.stop(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('shutdown did not drain')),1000))]);
  await active;assert.equal(runner.running,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM checks').get().n,0);
 }finally{db.close();}
});
