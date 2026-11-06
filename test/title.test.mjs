import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTitle, cleanTitle, createTitleRequest, LUNA_MODEL } from '../dist/app/title.js';
import { startApp } from '../dist/app/server.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
const tick = () => new Promise(r=>setImmediate(r));
test('title: Luna succeeds, input limited to 2000 characters, no second call', async()=>{
  const calls=[];
  assert.equal(await generateTitle('文'.repeat(2100),new AbortController().signal,async(m,t)=>{calls.push([m,t]);return '“修复会话标题。”';}), '修复会话标题');
  assert.deepEqual(calls.map(c=>c[0]),['luna']);assert.equal(calls[0][1].length,2000);
});
test('title: Luna error falls back once to Qwen; Qwen success',async()=>{
  const calls=[];assert.equal(await generateTitle('消息',new AbortController().signal,async m=>{calls.push(m);if(m==='luna')throw Error();return '本地标题';}), '本地标题');
  assert.deepEqual(calls,['luna','qwen']);
});
test('title: 20 second default deadline is configurable; timeout cancels Luna before Qwen',async()=>{
  const calls=[];let aborted=false;
  const result=await generateTitle('消息',new AbortController().signal,async(m,t,s)=>{calls.push(m);if(m==='luna'){s.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});}assert.ok(aborted);return '兜底';},10);
  assert.equal(result,'兜底');assert.deepEqual(calls,['luna','qwen']);
});
test('title: both fail, no retry; abort suppresses fallback and late result',async()=>{
  const calls=[];assert.equal(await generateTitle('消息',new AbortController().signal,async m=>{calls.push(m);throw Error();}),undefined);assert.deepEqual(calls,['luna','qwen']);
  const c=new AbortController(), d=deferred();let count=0;
  const p=generateTitle('消息',c.signal,async()=>{count++;return d.promise;});await tick();c.abort();assert.equal(await p,undefined);d.resolve('迟到');assert.equal(count,1);
});
test('title: controls, bidi, line breaks, quotes, punctuation and length cleaned',()=>{
  assert.equal(cleanTitle('“修复\u0000\n会话\u202e标题。”'), '修复 会话 标题');
  assert.ok([...cleanTitle('长'.repeat(100))].length<=32);
  assert.equal(cleanTitle('\u0000\n'), '');
});
test('title: independent Luna protocol is ephemeral, isolated, lowest effort, stops RPC',async()=>{
  const calls=[];let stopped=0, cwd;
  const rpc={closed:new Promise(()=>{}),notify(){},async stop(){stopped++;},async request(m,p){calls.push([m,p]);
    if(m==='config/read')return {config:{mcp_servers:{fixture:{}}}};
    if(m==='model/list')return {data:[{model:LUNA_MODEL,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'}]}]};
    if(m==='thread/start')return {thread:{id:'title-only'}};
    if(m==='turn/start'){rpc.onNotification('item/started',{item:{type:'userMessage'}});rpc.onNotification('item/completed',{item:{type:'agentMessage',text:'测试标题'}});rpc.onNotification('turn/completed',{turn:{status:'completed'}});return {turn:{id:'turn'}};}
    return {};
  }};
  const request=createTitleRequest({executable:async()=> 'fake',rpc:dir=>{cwd=dir;return rpc;}});
  assert.equal(await request('luna','只有用户消息',new AbortController().signal),'测试标题');assert.equal(stopped,1);
  const thread=calls.find(c=>c[0]==='thread/start')[1], turn=calls.find(c=>c[0]==='turn/start')[1];
  assert.equal(thread.ephemeral,true);assert.deepEqual(thread.dynamicTools,[]);assert.equal(thread.config.project_doc_max_bytes,0);
  assert.equal(thread.config['mcp_servers.fixture.enabled'],false);assert.equal(thread.config['features.shell_tool'],false);
  assert.equal(turn.effort,'low');assert.equal(turn.input[0].text,'只有用户消息');assert.equal(thread.cwd,cwd);
});
test('title: Qwen uses only validated local Responses route, off, no tools or redirects',async()=>{
  let seen;
  const request=createTitleRequest({local:()=>({model:'iq3_s',config:{baseURL:'http://127.0.0.1:9999/v1'}}),fetch:async(url,options)=>{seen={url,...options};return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'本地标题'}]}]})};}});
  assert.equal(await request('qwen','用户消息',new AbortController().signal),'本地标题');
  assert.equal(seen.url,'http://127.0.0.1:9999/v1/responses');assert.equal(seen.redirect,'error');
  const body=JSON.parse(seen.body);assert.equal(body.reasoning.effort,'off');assert.deepEqual(body.tools,[]);assert.equal(body.model,'iq3_s');assert.equal(body.store,false);
});
test('title: aborted Luna closes its own RPC and never waits for turn completion',async()=>{
  const closed=deferred(),started=deferred();let stops=0;
  const rpc={closed:closed.promise,notify(){},async stop(){stops++;closed.resolve();},async request(m){
    if(m==='config/read')return {};
    if(m==='model/list')return {data:[{model:LUNA_MODEL,supportedReasoningEfforts:['low']}]};
    if(m==='thread/start')return {thread:{id:'transient'}};
    if(m==='turn/start'){started.resolve();return {turn:{id:'one'}};}
    return {};
  }};
  const request=createTitleRequest({executable:async()=> 'fake',rpc:()=>rpc}),c=new AbortController();
  const task=request('luna','取消',c.signal);await started.promise;c.abort();await assert.rejects(task,/TITLE_CODEX_EXITED/);assert.equal(stops,1);
});
const factory=()=>({onMessage(){},onEvent(){},getSessionId(){return 'fake-title-member';},async start(){},async resume(){},async prompt(){return {status:'completed'};},async stop(){},async interrupt(){}});
async function fixture(t,request){
  const root=mkdtempSync(join(tmpdir(),'title-test-')),home=join(root,'home'),workspace=join(root,'project');mkdirSync(workspace);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let app=await startApp({home,factory,titleRequest:request});
  t.after(()=>app.close());
  const call=async(path,data)=>{const response=await fetch(app.origin+'/api/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  const project=await call('projects',{path:workspace}),session=await call('sessions',{projectId:project.id,members:[{name:'lead',harness:'codex',model:'unrelated',role:'lead'}]});
  return {get app(){return app;},call,session,home,async restart(){await app.close();app=await startApp({home,factory,titleRequest:request});}};
}
test('title: first send immediate placeholder; manual rename discards in-flight generation',async t=>{
  const d=deferred();let signal,calls=0;const f=await fixture(t,async(m,text,s)=>{calls++;signal=s;return d.promise;});
  await f.call(`sessions/${f.session.id}/messages`,{text:'第一条消息'});assert.equal((await f.call('state')).sessions[0].title,'第一条消息');
  await f.call(`sessions/${f.session.id}/rename`,{text:'手动名称'});assert.ok(signal.aborted);d.resolve('自动标题');await tick();
  await f.call(`sessions/${f.session.id}/messages`,{text:'第二条'});assert.equal((await f.call('state')).sessions[0].title,'手动名称');assert.equal(calls,1);
});
test('title: persists, generates only once across messages and restart; stream event updates UI',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return '自动标题';});await f.call(`sessions/${f.session.id}/messages`,{text:'首条'});
  await tick();assert.equal((await f.call('state')).sessions[0].title,'自动标题');
  assert.match(readFileSync(join(f.home,'events.jsonl'),'utf8'),/session-renamed/);
  await f.restart();await f.call(`sessions/${f.session.id}/messages`,{text:'重启后'});assert.equal(calls,1);assert.equal((await f.call('state')).sessions[0].title,'自动标题');
});
test('title: both fail keeps placeholder and writes exactly one internal log',async t=>{
  let count=0;const f=await fixture(t,async()=>{count++;throw Error('private error');});await f.call(`sessions/${f.session.id}/messages`,{text:'原始标题'});await tick();
  await f.call(`sessions/${f.session.id}/messages`,{text:'再发'});assert.equal((await f.call('state')).sessions[0].title,'原始标题');assert.equal(count,2);
  assert.equal(readFileSync(join(f.home,'title.log'),'utf8').trim().split('\n').length,1);
  assert.ok(!(await f.call(`sessions/${f.session.id}/events`)).some(e=>e.type==='session-error'||e.type==='member-failed'));
});
for(const mode of ['close','stop'])test(`title: ${mode} cancels without waiting for uncooperative request`,async t=>{
  let signal;const f=await fixture(t,async(m,text,s)=>{signal=s;return new Promise(()=>{});});await f.call(`sessions/${f.session.id}/messages`,{text:'取消测试'});
  if(mode==='close')await f.app.close();else await f.call(`sessions/${f.session.id}/stop`,{});assert.ok(signal.aborted);
});
test('title: old metadata never backfilled even when first message arrives later',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return '不可调用';});await f.app.close();
  const path=join(f.home,'sessions',f.session.id,'session.json'),meta=JSON.parse(readFileSync(path,'utf8'));delete meta.titleState;writeFileSync(path,JSON.stringify(meta));
  await f.restart();await f.call(`sessions/${f.session.id}/messages`,{text:'旧会话消息'});assert.equal(calls,0);
});

