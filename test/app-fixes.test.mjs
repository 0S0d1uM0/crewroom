import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { initialState, reduce, coalesceRecords } from '../ui/state.js';
import { initRepository, git, gitAsync, snapshot } from '../dist/platform/storage.js';
import { startApp } from '../dist/app/server.js';
import { shellAllowed, toolDenial } from '../dist/platform/permissions.js';
const member = {name:'lead',role:'lead',harness:'codex',model:'x'};
function fixture(t) { const dir=mkdtempSync(join(tmpdir(),'fix-')); t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})); const workspace=join(dir,'project');mkdirSync(workspace);return {dir,workspace,home:join(dir,'home')}; }
function fakeFactory(log=[],fail={}) { return m=>({onMessage(){},onEvent(){},getSessionId(){return 'saved-'+m.name;},async start(){},async resume(id){log.push(['resume',id]);},async stop(){},async interrupt(){},async steer(){return 'idle';},async prompt(text){log.push(['prompt',text]);if(fail.once){fail.once=false;throw Error('fixture crash');}this.onMessage('done');return {status:'completed'};}}); }
function call(app,path,body) {return fetch(app.origin+'/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(async r=>{const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;});}
test('5000 events apply once in linear time, including reversed delivery',()=>{
 const events=Array.from({length:5000},(_,i)=>({sequence:i+1,type:i%2?'turn-end':'turn-start',member:'lead',usage:{totalTokens:7}}));
 function run(list){const s=initialState({members:[member]}),before=process.memoryUsage().heapUsed,t=performance.now();for(const e of list)assert.equal(reduce(s,e),s);return {s,ms:performance.now()-t,heap:process.memoryUsage().heapUsed-before};}
 const small=run(events.slice(0,2500)),big=run(events);
 assert.equal(big.s.members.lead.turns,2500);assert.equal(big.s.members.lead.tokens,17500);
 for(const e of events)reduce(big.s,e);assert.equal(big.s.members.lead.tokens,17500);assert.equal(big.s.activities.length,5000);
 const reversed=run([...events].reverse());assert.equal(reversed.s.members.lead.tokens,17500);assert.equal(reversed.s.buffer.size,0);
 assert.ok(big.ms < Math.max(100,small.ms*8));assert.ok(big.heap<32*1024**2);
 console.log('5000 events:',JSON.stringify({smallMs:small.ms,largeMs:big.ms,heapBytes:big.heap,reverseMs:reversed.ms}));
});
test('URLs and null devices pass both shell checks; outside files still fail',()=>{
 const root=resolve('.test-state'),session=join(root,'s');
 for(const c of ['curl.exe -s -o NUL -w "%{http_code}" https://example.com',"echo 'https://example.com/path'",'curl https://example.com > /dev/null','node x.js 2>/dev/null']){assert.equal(shellAllowed(c,root,session),true,c);assert.equal(toolDenial('pwsh',{command:c},root,session),undefined);}
 for(const c of ['cat C:/outside/secret','cat /etc/passwd','cat ../outside'])assert.equal(shellAllowed(c,root,session),false,c);
});
test('initial commit stores exact bytes, excludes secrets and leaves clean status',async t=>{
 const {workspace}=fixture(t),files={'crlf.txt':'a\r\nb\r\n','lf.txt':'a\nb\n','mixed.txt':'a\r\nb\nc\r\n','.env':'secret','.env.local':'secret','tls.pem':'secret','tls.key':'secret','id_rsa_test':'secret','mycredentials.txt':'secret'};
 for(const [name,text] of Object.entries(files))writeFileSync(join(workspace,name),text);
 const result=await initRepository(workspace);
 for(const [name,text] of Object.entries(files))assert.equal(readFileSync(join(workspace,name),'utf8'),text);
 for(const name of ['crlf.txt','lf.txt','mixed.txt'])assert.equal(await gitAsync(workspace,['show','HEAD:'+name]),files[name].replace(/\r?\n$/,''));
 assert.equal(git(workspace,['status','--porcelain']), '');assert.equal(result.excluded.length,6);assert.equal(git(workspace,['config','--local','core.autocrlf']),'false');
 assert.ok(!readdirSync(workspace).includes('.gitignore'));
});
test('snapshot across 20000 files keeps state responsive and reuses index/objects',async t=>{
 const {dir,workspace,home}=fixture(t);await initRepository(workspace);
 const folder=join(workspace,'many');mkdirSync(folder);
 for(let i=0;i<20000;i++)writeFileSync(join(folder,i+'.txt'),'file '+i);
 const app=await startApp({home,factory:fakeFactory()});
 try {
  const p=await call(app,'projects',{path:workspace}),s=await call(app,'sessions',{projectId:p.id,members:[member]});
  const snapdir=join(dir,'snap');mkdirSync(snapdir);
  const firstAt=performance.now(),pending=snapshot(workspace,snapdir,s.id,1);
  const latencies=[]; for(let i=0;i<8;i++){const at=performance.now();await call(app,'state');latencies.push(performance.now()-at);}
  const first=await pending,firstMs=performance.now()-firstAt;
  function size(path){return readdirSync(path,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?size(join(path,e.name)):statSync(join(path,e.name)).size),0);}
  const before=size(join(workspace,'.git','objects')),at=performance.now(),second=await snapshot(workspace,snapdir,s.id,2),secondMs=performance.now()-at,after=size(join(workspace,'.git','objects'));
  assert.ok(first.commit && second.commit);assert.ok(Math.max(...latencies)<1000);assert.ok(secondMs<firstMs);assert.ok(after-before<4096);assert.deepEqual(readdirSync(snapdir),['snapshot-index']);
  console.log('snapshot benchmark:',JSON.stringify({files:20000,firstMs,secondMs,stateMaxMs:Math.max(...latencies),objectGrowthBytes:after-before}));
 } finally {await app.close();}
});
test('oversized untracked content snapshots only tracked files',async t=>{
 const {dir,workspace}=fixture(t);writeFileSync(join(workspace,'tracked'),'one');await initRepository(workspace);writeFileSync(join(workspace,'tracked'),'two');
 const snapdir=join(dir,'snap');mkdirSync(snapdir);
 writeFileSync(join(workspace,'large'),'small');await snapshot(workspace,snapdir,'large',0);
 const {open}=await import('node:fs/promises');const file=await open(join(workspace,'large'),'w');await file.truncate(2*1024**3+1);await file.close();
 const result=await snapshot(workspace,snapdir,'large',1);
 assert.equal(result.limited,true);assert.equal(git(workspace,['show',result.commit+':tracked']),'two');assert.equal(git(workspace,['ls-tree','--name-only',result.commit]),'tracked');
});
test('paused restart shows paused before loading and continue dispatches queued work',async t=>{
 const {workspace,home}=fixture(t),log=[];let app=await startApp({home,factory:fakeFactory(log)});
 try {
 const p=await call(app,'projects',{path:workspace}),s=await call(app,'sessions',{projectId:p.id,members:[member]});
 await call(app,'sessions/'+s.id+'/pause',{});await call(app,'sessions/'+s.id+'/messages',{text:'queued'});
 await app.close();app=await startApp({home,factory:fakeFactory(log)});
 assert.equal((await call(app,'state')).sessions[0].status,'已暂停');assert.equal(log.length,0);
 await call(app,'sessions/'+s.id+'/resume',{});await app.live.get(s.id).waitForSettled();assert.ok(log.some(e=>e[0]==='prompt'&&e[1].includes('queued')));
 }finally{await app.close();}
});
test('failed member retries on next message, including after restart',async t=>{
 const {workspace,home}=fixture(t),log=[],fail={once:true};let app=await startApp({home,factory:fakeFactory(log,fail)});
 try {
 const p=await call(app,'projects',{path:workspace}),s=await call(app,'sessions',{projectId:p.id,members:[member]});
 await call(app,'sessions/'+s.id+'/messages',{text:'crash'});await app.live.get(s.id).waitForSettled();assert.equal(app.live.get(s.id).summary().members[0].failed,true);
 await app.close();app=await startApp({home,factory:fakeFactory(log)});
 await call(app,'sessions/'+s.id+'/messages',{text:'retry'});await app.live.get(s.id).waitForSettled();assert.equal(app.live.get(s.id).summary().members[0].failed,false);assert.ok(log.some(e=>e[0]==='prompt'&&e[1].includes('retry')));
 }finally{await app.close();}
});
test('snapshot requests coalesce and three consecutive failures disable only that session',async t=>{
 const {workspace,dir}=fixture(t);writeFileSync(join(workspace,'file'),'initial');await initRepository(workspace);
 const snapdir=join(dir,'snap');mkdirSync(snapdir);
 const one=snapshot(workspace,snapdir,'coalesced',1),two=snapshot(workspace,snapdir,'coalesced',2),three=snapshot(workspace,snapdir,'coalesced',3);
 assert.equal(one,two);assert.equal(two,three);const result=await one;assert.equal(result.ref,'refs/agents/coalesced/3');
 assert.equal(git(workspace,['for-each-ref','--format=%(refname)','refs/agents/coalesced']).split('\n').length,2);
 rmSync(join(snapdir,'snapshot-index'));mkdirSync(join(snapdir,'snapshot-index'));
 for(let i=0;i<3;i++)await assert.rejects(snapshot(workspace,snapdir,'coalesced',4+i),i===2?/快照已关闭/:/Error/);
 rmSync(join(snapdir,'snapshot-index'),{recursive:true});assert.equal(await snapshot(workspace,snapdir,'coalesced',7),undefined);
 const other=join(dir,'other');mkdirSync(other);assert.ok(await snapshot(workspace,other,'other',1));
});

test('killed snapshot cleans its private lock and the next request succeeds',async t=>{
 const {workspace,dir}=fixture(t);writeFileSync(join(workspace,'file'),'initial');await initRepository(workspace);
 const snapdir=join(dir,'snap');mkdirSync(snapdir);let killed=false;
 const runGit=async(cwd,args,env,timeout)=>{
   if(args[0]==='add'&&!killed){killed=true;writeFileSync(env.GIT_INDEX_FILE+'.lock','interrupted');throw Object.assign(Error('fixture timeout'),{killed:true});}
   return gitAsync(cwd,args,env,timeout);
 };
 await assert.rejects(snapshot(workspace,snapdir,'timeout',1,{runGit,timeoutMs:300}),/timeout/);
 assert.ok(await snapshot(workspace,snapdir,'timeout',2));
 assert.ok(!readdirSync(snapdir).some(f=>f.endsWith('.lock')));
});
test('alternating worktrees retain independent reusable indexes',async t=>{
 const {workspace,dir}=fixture(t);writeFileSync(join(workspace,'file'),'initial');await initRepository(workspace);
 const a=join(dir,'a'),b=join(dir,'b'),snapdir=join(dir,'snap');mkdirSync(snapdir);
 git(workspace,['worktree','add','-b','a',a]);git(workspace,['worktree','add','-b','b',b]);
 writeFileSync(join(a,'a.txt'),'A');writeFileSync(join(b,'b.txt'),'B');
 const first=await snapshot(a,snapdir,'wt',1),second=await snapshot(b,snapdir,'wt',2),third=await snapshot(a,snapdir,'wt',3);
 assert.equal(git(workspace,['rev-parse',first.commit+'^{tree}']),git(workspace,['rev-parse',third.commit+'^{tree}']));
 assert.equal(git(workspace,['ls-tree','--name-only',second.commit]).includes('a.txt'),false);
 const indexes=readdirSync(snapdir);assert.equal(indexes.length,2);assert.ok(indexes.every(f=>f.startsWith('snapshot-index-')));
});
test('message updates merge one logical reply without duplicating dialogue rows',()=>{
 const s=initialState({members:[member]});
 reduce(s,{sequence:1,type:'to-user',member:'lead',messageId:'lead:1',text:'first'});
 reduce(s,{sequence:2,type:'tool',member:'lead',id:'t'});
 reduce(s,{sequence:3,type:'message-update',member:'lead',messageId:'lead:1',text:'first second'});
 assert.equal(s.messages.length,1);assert.equal(s.messages[0].text,'first second');assert.equal(s.activities[0].text,'first second');assert.equal(s.activities.length,2);
});
test('one turn with multiple text items persists a single logical user reply',async t=>{
 const {workspace,home}=fixture(t);const factory=m=>{
 const a=fakeFactory()(m);a.prompt=async()=>{a.onMessage('前半句');a.onEvent({type:'tool',id:'call',title:'Read'});a.onMessage('后半句');return {status:'completed'};};return a;
 };
 const app=await startApp({home,factory});
 try{const p=await call(app,'projects',{path:workspace}),s=await call(app,'sessions',{projectId:p.id,members:[member]});
 await call(app,'sessions/'+s.id+'/messages',{text:'start'});await app.live.get(s.id).waitForSettled();
 const events=await call(app,'sessions/'+s.id+'/events');assert.equal(events.filter(e=>e.type==='to-user').length,1);
 const update=events.find(e=>e.type==='message-update');assert.equal(update.text,'后半句');assert.equal(update.append,true);
 assert.equal(coalesceRecords(events).find(e=>e.type==='to-user').text,'前半句后半句');
 const view=initialState({members:[member]});for(const e of events)reduce(view,e);assert.equal(view.messages.filter(m=>m.role==='lead').length,1);assert.equal(view.messages.at(-1).text,'前半句后半句');
 }finally{await app.close();}
});
