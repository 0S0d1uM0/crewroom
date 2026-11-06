import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaMonitor, quotaNotices, QUOTA_POLL_MS } from '../dist/app/quota-monitor.js';
import { serviceEnded, closeAction } from '../dist/app/shell.js';
const data=(used=90,reset=Date.now()+86400000)=>({rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:Math.floor(reset/1000)}}});
test('service quota polling uses one connection across members and sessions, skips paused and non-Codex',async()=>{
 let calls=0,finish;const logs=[];
 const member=(h='codex',state='idle')=>({config:{harness:h,name:'a'},state,adapter:{readQuota:()=>{calls++;return new Promise(r=>finish=r);}}});
 const session=(members,paused=false)=>({members:new Map(members.map((m,i)=>[i,m])),paused,storage:{event:(...e)=>logs.push(e)}});
 const monitor=new QuotaMonitor(),sessions=[session([member(),member()]),session([member()])];
 const pending=monitor.poll(sessions);await monitor.poll(sessions);assert.equal(calls,1);finish(data());await pending;assert.equal(logs[0][0],'rate-limits');
 await monitor.poll([session([member()],true),session([member('claude'),member('dsh'),member('codex','paused')])]);assert.equal(calls,1);assert.equal(QUOTA_POLL_MS,300000);
});
test('read failure emits only warning and leaves members available',async()=>{
 const logs=[],m={config:{harness:'codex'},state:'busy',failed:false,adapter:{readQuota:async()=>{throw Error('timeout');}}};
 await new QuotaMonitor().poll([{members:new Map([['a',m]]),storage:{event:(...e)=>logs.push(e)}}]);
 assert.equal(m.state,'busy');assert.equal(m.failed,false);assert.equal(logs.length,1);assert.equal(logs[0][0],'protocol-warning');
});
test('15 percent threshold deduplicates from durable journal; recovery and reset rearm independently',()=>{
 const d=data(),first=quotaNotices('codex',d).events;assert.equal(first.length,1);assert.match(first[0].text,/剩余 10%/);
 const journal=JSON.parse(JSON.stringify(first));assert.equal(quotaNotices('codex',d,journal).events.length,0);
 assert.equal(quotaNotices('codex',data(85),journal).events[0].type,'quota-rearmed');
 const recovered=[...journal,...quotaNotices('codex',data(85),journal).events];assert.equal(quotaNotices('codex',d,recovered).events.length,1);
 assert.equal(quotaNotices('codex',data(92,Date.now()+172800000),journal).events.length,1);
 assert.equal(quotaNotices('codex',data(99,Date.now()-10000),journal).events[0].type,'quota-rearmed');
 const both={rateLimits:{...d.rateLimits,secondary:{usedPercent:99,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}};assert.equal(quotaNotices('codex',both).events.length,2);
});
test('shell follows service loss and identity changes; red close still hides',()=>{
 const info={pid:123,token:'a',port:456};assert.equal(serviceEnded(info,{...info},true),false);
 assert.equal(serviceEnded(info,info,false),true);assert.equal(serviceEnded(info,undefined,true),true);assert.equal(serviceEnded(info,{...info,token:'b'},true),true);
 assert.equal(closeAction(false),'hide');assert.equal(closeAction(true),'close');
});

test('reset times that wobble by seconds stay one cycle, as they do in real Codex reads',()=>{
  const read=resetsAt=>({rateLimits:{limitId:'codex',primary:{usedPercent:90,windowDurationMins:300,resetsAt}}});
  const first=quotaNotices('codex',read(Math.floor(Date.now()/1000)+86400),[]).events;
  assert.equal(first.filter(e=>e.type==='quota-notice').length,1);
  const journal=first.map(e=>({...e}));
  assert.equal(quotaNotices('codex',read(Math.floor(Date.now()/1000)+86404),journal).events.length,0);
  assert.equal(quotaNotices('codex',read(Math.floor(Date.now()/1000)+86400+5*3600),journal).events.filter(e=>e.type==='quota-notice').length,1);
});
test('a member whose harness has not started is skipped and the next one answers',async()=>{
  const seen=[];
  const make=(name,readQuota)=>({config:{name,harness:'codex'},state:'idle',failed:false,adapter:{readQuota}});
  const members=[make('未启动',async()=>undefined),make('已启动',async()=>({ordinaryUsageAllowed:true}))];
  const session={paused:false,members:new Map(members.map(m=>[m.config.name,m])),storage:{event:(type,data)=>seen.push({type,...data})}};
  await new QuotaMonitor().poll([session]);
  assert.deepEqual(seen.map(e=>[e.type,e.member]),[['rate-limits','已启动']]);
});
