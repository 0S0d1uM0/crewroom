import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startApp } from '../dist/app/server.js';
import { serviceInfo } from '../dist/app/lock.js';
import { closeAction, confirmation, activeCount, stopService } from '../dist/app/shell.js';
import { productionPaths, packageApp } from '../scripts/app-package.mjs';
const base = resolve('.test-state'); mkdirSync(base, { recursive: true });
function fixture(t) { const home = mkdtempSync(join(base, 'shell-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; }
test('close hides until quitting; confirmation includes all loaded sessions', () => {
  assert.equal(closeAction(false), 'hide'); assert.equal(closeAction(true), 'close');
  assert.match(confirmation(3).message, /3 个会话.*停止所有会话和 Harness/);
  assert.equal(activeCount({ sessions: ['运行中','空闲','已暂停','已停止','未加载','错误'].map(status=>({status})) }), 3);
});
test('shutdown handles absent, graceful, timeout and changed service identity', async () => {
  const info = { pid: 123, port: 1, token: 'a' }; let killed = [], live = false, time = 0;
  const hooks = { request: async()=>{}, alive:()=>live, same:()=>true, kill: pid=>killed.push(pid), now:()=>time, delay:async()=>{time+=100;}, timeout:200 };
  assert.equal(await stopService(info,hooks),'absent'); live=true;
  assert.equal(await stopService(info,{...hooks, request:async()=>{live=false;}}),'stopped'); live=true;
  assert.equal(await stopService(info,{...hooks,request:async()=>{throw Error('unreachable');}}),'forced'); assert.deepEqual(killed,[123]);
  assert.equal(await stopService(info,{...hooks,same:()=>false}),'replaced'); assert.equal(killed.length,1);
});
test('shutdown bounds a request that never returns', async () => {
  let killed = false;
  assert.equal(await stopService({pid:123,port:1,token:'a'}, { request:()=>new Promise(()=>{}), alive:()=>true, same:()=>true, kill:()=>{killed=true;}, timeout:10 }), 'forced');
  assert.equal(killed,true);
});
test('shutdown authenticates token and requires exact Origin, stops fake sessions and releases lock', async t => {
  const home = fixture(t); let stopped=0;
  const factory=()=>({onMessage(){},onEvent(){},async start(){},async prompt(){return {status:'completed'};},async interrupt(){},async stop(){stopped++;}});
  const app=await startApp({home,factory}); t.after(()=>app.close());
  const headers={Authorization:'Bearer '+app.token, Origin:app.origin,'Content-Type':'application/json'};
  const request=(path,value,extra={})=>fetch(app.origin+'/api/'+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
  assert.equal((await request('shutdown',{}, {Authorization:'bad'})).status,401);
  assert.equal((await request('shutdown',{}, {Origin:'https://evil.test'})).status,403);
  const noOrigin=await fetch(app.origin+'/api/shutdown',{method:'POST',headers:{Authorization:headers.Authorization}}); assert.equal(noOrigin.status,403);
  const project=await (await request('projects',{path:home})).json();
  await request('sessions',{projectId:project.id,members:[{name:'lead',role:'lead',harness:'codex',model:'gpt-6.1-sol'}]});
  assert.deepEqual(await (await request('shutdown',{})).json(),{ok:true}); await app.close();
  assert.equal(stopped,1); assert.equal(serviceInfo(home),undefined);
});
test('shutdown waits for an in-flight fake session startup before stopping it', async t => {
  const home=fixture(t); let begin,finish,stopped=0;
  const entered=new Promise(r=>begin=r), gate=new Promise(r=>finish=r);
  const app=await startApp({home,factory:()=>({onMessage(){},onEvent(){},async start(){begin();await gate;},async prompt(){return {status:'completed'};},async interrupt(){},async stop(){stopped++;}})});t.after(()=>app.close());
  const headers={Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'};
  const post=(path,data)=>fetch(app.origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(data)});
  const p=await(await post('projects',{path:home})).json();
  const starting=post('sessions',{projectId:p.id,members:[{name:'lead',role:'lead',harness:'codex',model:'gpt-6.1-sol'}]}); await entered;
  assert.equal((await post('shutdown',{})).status,200); finish(); await starting; await app.close();assert.equal(stopped,1);assert.equal(serviceInfo(home),undefined);
});
test('standalone shutdown exits its isolated process and releases its lock', async t => {
  const home=fixture(t), child=spawn(process.execPath,['dist/app/server.js'],{env:{...process.env,CREWROOM_HOME:home,CREWROOM_SMOKE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();}); const exited=once(child,'exit');
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const url=await new Promise((yes,no)=>{let out='';const timer=setTimeout(()=>no(Error('startup timeout '+stderr)),10000);child.stdout.on('data',c=>{out+=c;const m=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);if(m){clearTimeout(timer);yes(new URL(m[0]));}});child.once('error',no);});
  const r=await fetch(url.origin+'/api/shutdown',{method:'POST',headers:{Authorization:'Bearer '+url.searchParams.get('token'),Origin:url.origin}});assert.deepEqual(await r.json(),{ok:true});
  const timer=setTimeout(()=>child.kill(),10000);try{assert.equal((await exited)[0],0);}finally{clearTimeout(timer);}assert.equal(serviceInfo(home),undefined);
});
test('package selects production and nested dependencies while excluding development packages', () => {
  assert.deepEqual(productionPaths({packages:{'':{},'node_modules/zod':{},'node_modules/electron':{dev:true},'node_modules/typescript':{},'node_modules/@types/node':{},'node_modules/pkg/node_modules/zod':{},'node_modules/test':{dev:true}}}),['node_modules/zod','node_modules/pkg/node_modules/zod']);
});
test('package keeps nested production modules and can replace a previous complete package', t => {
  const root=fixture(t); const put=(path,text='x')=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
  for(const path of ['node_modules/electron/dist/electron.exe','node_modules/electron/dist/resources/default_app.asar','dist/app/electron/main.js','ui/index.html','assets/icon.png','node_modules/prod/index.js','node_modules/prod/node_modules/nested/index.js','node_modules/dev/index.js'])put(path);
  put('package.json',JSON.stringify({version:'1',dependencies:{prod:'1'}}));put('package-lock.json',JSON.stringify({packages:{'node_modules/prod':{},'node_modules/prod/node_modules/nested':{},'node_modules/dev':{dev:true}}}));
  for(let i=0;i<2;i++){const target=packageApp(root);assert.ok(existsSync(join(target,'Crewroom.exe')));assert.ok(!existsSync(join(target,'resources/default_app.asar')));assert.ok(!existsSync(join(target,'resources/app/node_modules/dev')));assert.ok(existsSync(join(target,'resources/app/node_modules/prod/node_modules/nested/index.js')));assert.equal(JSON.parse(readFileSync(join(target,'resources/app/package.json'))).main,'dist/app/electron/main.js');}
});
test('recovery startup failure is stopped and awaited by shutdown (review H1)', async t => {
  const home=fixture(t), members=[{name:'lead',role:'lead',harness:'codex',model:'gpt-6.1-sol'}];
  let fail=false, stopped=0, entered,finish;
  const gate=new Promise(r=>finish=r), beginning=new Promise(r=>entered=r);
  const factory=()=>({onMessage(){},onEvent(){},async start(){if(fail){entered();await gate;throw Error('fake recovery failure');}},async prompt(){return {status:'completed'};},async interrupt(){},async stop(){stopped++;}});
  let app=await startApp({home,factory});
  const call=async(path,data)=>fetch(app.origin+'/api/'+path,{method:'POST',headers:{Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const p=await(await call('projects',{path:home})).json(),s=await(await call('sessions',{projectId:p.id,members})).json();await app.close();fail=true;stopped=0;
  app=await startApp({home,factory});t.after(()=>app.close());
  const recovery=call(`sessions/${s.id}/messages`,{text:'recover'});await beginning;
  assert.equal((await call('shutdown',{})).status,200);let closed=false;const closing=app.close().then(()=>{closed=true;});
  await new Promise(r=>setImmediate(r));assert.equal(closed,false);finish();assert.equal((await recovery).status,400);await closing;
  assert.equal(stopped,1);assert.equal(serviceInfo(home),undefined);
});
test('server CLI smoke refuses a missing isolated home before reading service data (review H2)', async t => {
  const home=fixture(t), env={...process.env,CREWROOM_SMOKE:join(home,'result.json')};delete env.CREWROOM_HOME;
  const child=spawn(process.execPath,['dist/app/server.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',c=>error+=c);
  const [code]=await once(child,'exit');assert.notEqual(code,0);assert.match(error,/冒烟模式必须设置 CREWROOM_HOME/);
});
test('failed package assembly leaves previous complete product untouched', t => {
  const root=fixture(t), target=join(root,'release/Crewroom');mkdirSync(target,{recursive:true});writeFileSync(join(target,'Crewroom.exe'),'original');
  assert.throws(()=>packageApp(root));assert.equal(readFileSync(join(target,'Crewroom.exe'),'utf8'),'original');assert.equal(existsSync(join(root,'release/Crewroom.staging')),false);
});
test('packaged relative runtime paths exist after build', () => {
  for(const path of ['dist/mock-agent.js','dist/platform/dsh-steer-plugin.js','ui/index.html','node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js','assets/icon.ico','assets/icon.png']) assert.ok(existsSync(resolve(path)),path);
});
test('missing lock never authorizes killing an unconfirmed PID (review N1)', async () => {
  let time=0,killed=false,signal;
  const info={pid:123,port:1,token:'a'},hooks={request:async s=>{signal=s;},alive:()=>true,same:()=>undefined,kill:()=>{killed=true;},now:()=>time,delay:async()=>{time+=100;},timeout:200};
  assert.equal(await stopService(info,hooks),'replaced');assert.equal(killed,false);assert.equal(signal.aborted,true);
  time=0;assert.equal(await stopService(info,{...hooks,alive:()=>time<100}),'stopped');assert.equal(killed,false);
});

test('closing to the tray does not block a Windows shutdown', () => {
  const source = readFileSync(new URL('../src/app/electron/main.ts', import.meta.url), 'utf8');
  assert.match(source, /query-session-end/); assert.match(source, /'session-end'/);
});
