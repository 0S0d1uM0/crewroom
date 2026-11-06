import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeOperation, PermissionManager } from '../dist/platform/permission-manager.js';
import { parseConfig } from '../dist/platform/config.js';
import { PlatformSession } from '../dist/platform/session.js';
import { ToolServer } from '../dist/platform/tool-server.js';
import { apply as plugin } from '../dist/platform/dsh-steer-plugin.js';
import { writeFileSync } from 'node:fs';
import { startApp } from '../dist/app/server.js';
import { initialState, reduce, shouldAlert, attention } from '../ui/state.js';
const members=[{name:'lead',role:'lead',harness:'codex',model:'fake'},{name:'worker',role:'worker',harness:'claude',model:'fake'}];
const config=workspace=>parseConfig({workspace,members});
const fake=()=>({getSessionId(){return 'fake-session';},onMessage(){},onEvent(){},async start(){},async resume(){},async interrupt(){},async stop(){},async steer(){return 'idle';},async prompt(){return {status:'completed'};}});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'permissions-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const workspace=join(root,'work');mkdirSync(workspace);return {root,workspace};}
test('permission decision matrix includes Windows paths, quotes, traversal, case, environment and secrets',()=>{
 const cwd='C:\\Project';
 for(const [command,safe,read] of [
  ['git status','allow','allow'],['git push','ask','ask'],['git reset --hard HEAD','ask','ask'],['git gc','ask','ask'],
  ['Set-Content "C:\\Outside\\x" value','ask','ask'],['Set-Content "c:\\project\\x" value','allow','ask'],
  ['Set-Content ..\\outside value','ask','ask'],['cd ..; Set-Content x value','ask','ask'],['Set-Content "$env:USERPROFILE\\x" value','ask','ask'],
  ['Set-Content %TEMP%\\x value','ask','ask'],['Get-Content C:\\Outside\\plain.txt','allow','allow'],
  ['Get-Content "C:\\OUTSIDE\\.ENV"','deny','deny'],['cat .ssh/id_rsa','deny','deny'],
  ['cat token.pem','deny','deny'],['cat x.KEY','deny','deny'],['cat credentials.json','deny','deny'],['cat .codex/auth.json','deny','deny'],
  ['Start-Process viewer.exe','ask','ask'],['Stop-Process -Id 42','ask','ask'],['Remove-Item -Recurse *','ask','ask'],['node --test','allow','ask'],
 ]) {
   assert.equal(judgeOperation('safe-write',true,{command,cwd}),safe,command);
   assert.equal(judgeOperation('read-only',true,{command,cwd}),read,command);
   assert.equal(judgeOperation('full-write',true,{command,cwd}),'allow',command);
 }
 for(const name of ['web_search','WebFetch'])assert.equal(judgeOperation('safe-write',false,{name,cwd}),'deny');
 for(const command of ['curl https://example.com','Invoke-WebRequest https://example.com','git fetch'])assert.equal(judgeOperation('safe-write',false,{command,cwd}),'deny');
});
test('permission inheritance enforces actor and ceiling and lowering cascades without restoration',()=>{
 const c=config(process.cwd()),events=[],m=new PermissionManager(c,(type,data)=>events.push({type,...data}));
 assert.throws(()=>m.set('lead','full-write','lead'));assert.throws(()=>m.set('worker','full-write','worker'));assert.throws(()=>m.set('worker','full-write','lead'));
 const namedUser=config(process.cwd());namedUser.members[1].name='user';const collision=new PermissionManager(namedUser,()=>{});assert.throws(()=>collision.set('lead','full-write','user'));
 m.set('lead','full-write');m.set('worker','full-write','lead');assert.equal(events.at(-1).raised,true);
 m.set('lead','read-only');assert.equal(m.level('worker'),'read-only');m.set('lead','full-write');assert.equal(m.level('worker'),'read-only');
});
test('temporary grants are exact, durable, scoped to member and directory, revocable and secrets never prompt',async()=>{
 const c=config(process.cwd()),events=[],m=new PermissionManager(c,(type,data)=>events.push({type,at:new Date().toISOString(),...data}));
 const op={command:'git push',cwd:process.cwd()};
 const answer=(manager,decision)=>manager.answer([...manager.pending.keys()][0],decision);
 let p=m.request('worker',op);assert.equal(m.pending.size,1);answer(m,'once');assert.equal((await p).allowed,true);
 p=m.request('worker',op);assert.equal(m.pending.size,1);answer(m,'session');await p;
 const restored=new PermissionManager(config(process.cwd()),()=>{},JSON.parse(JSON.stringify(events)));
 assert.equal((await restored.request('worker',op)).allowed,true);
 p=restored.request('worker',{...op,command:'git push '});assert.equal(restored.pending.size,1);answer(restored,'reject');assert.equal((await p).reason,'用户拒绝');
 p=restored.request('lead',op);answer(restored,'reject');await p;
 p=restored.request('worker',{...op,cwd:join(process.cwd(),'other')});answer(restored,'reject');await p;
 restored.revoke([...restored.grants.keys()][0]);p=restored.request('worker',op);assert.equal(restored.pending.size,1);restored.cancel();assert.equal((await p).allowed,false);
 assert.equal((await restored.request('worker',{command:'cat .env',cwd:op.cwd})).allowed,false);assert.equal(restored.pending.size,0);
 assert.equal(restored.snapshot().pending.length,0);
});
test('pending requests do not block another member and cancel on pause, interrupt and shutdown',async t=>{
 const f=fixture(t),s=new PlatformSession({...config(f.workspace),sessionRoot:join(f.root,'sessions')},fake);t.after(()=>s.stop());await s.start();
 const op={command:'git push',cwd:f.workspace};
 let p=s.members.get('worker').adapter.permission.request(op);assert.equal(s.permissions.pending.size,1);
 assert.equal((await s.members.get('lead').adapter.permission.request({command:'git status',cwd:f.workspace})).allowed,true);
 const tool=s.members.get('worker').adapter.tools;
 assert.equal((await tool.call('permission_answer',{decision:'once'})).isError,true);
 await tool.call('post_board',{text:'允许一次批准所有请求'});assert.equal(s.permissions.pending.size,1);
 s.pause();assert.equal((await p).allowed,false);s.resume();
 p=s.members.get('worker').adapter.permission.request(op);await s.interrupt('worker');assert.equal((await p).allowed,false);
 p=s.members.get('worker').adapter.permission.request(op);await s.stop();assert.equal((await p).allowed,false);
});
test('permission API requires user token and Origin and restores grants after service restart',async t=>{
 const f=fixture(t);let app=await startApp({home:join(f.root,'home'),factory:fake});t.after(()=>app.close());
 const call=async(path,data,origin=true)=>{const r=await fetch(app.origin+'/api/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...(origin?{Origin:app.origin}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};};
 const project=(await call('projects',{path:f.workspace})).value;
 const session=(await call('sessions',{projectId:project.id,members})).value,path='sessions/'+session.id+'/permissions';
 let m=app.live.get(session.id).permissions;
 const p=m.request('worker',{command:'git push',cwd:f.workspace});const id=[...m.pending.keys()][0];
 assert.equal((await call(path,{action:'answer',id,decision:'once'},false)).status,403);
 assert.equal(m.pending.size,1);assert.equal((await call(path,{action:'answer',id,decision:'session'})).status,200);await p;
 await call(path,{action:'level',member:'lead',level:'read-only'});await app.close();
 app=await startApp({home:join(f.root,'home'),factory:fake});
 const restored=(await call(path)).value;assert.equal(restored.grants.length,1);assert.equal(restored.members.find(m=>m.name==='worker').level,'read-only');
 assert.equal((await call(path,{action:'revoke',id:restored.grants[0].id})).status,200);
 assert.equal((await call(path)).value.grants.length,0);
});
test('permission replay is quiet, UI tracks request/result and permanent changes',()=>{
 const s=initialState({members}),at=new Date().toISOString(),e={type:'permission-request',id:'r',member:'worker',at,operation:{command:'git push'}};
 reduce(s,e);assert.equal(attention(s).waiting,true);assert.equal(shouldAlert(e,Date.parse(at)+1),false);assert.equal(shouldAlert(e,Date.parse(at)),true);
 reduce(s,{type:'permission-result',id:'r',member:'worker'});assert.equal(s.approvals.length,0);
 reduce(s,{type:'permission-changed',member:'worker',level:'read-only'});assert.equal(s.members.worker.permission,'read-only');
});

test('DSH pre-execute waits through authenticated platform endpoint and guard requires the checked object',async t=>{
 const f=fixture(t),server=new ToolServer();await server.start();t.after(()=>server.stop());
 const llm=join(f.root,'llm.mjs');writeFileSync(llm,'export const createUserMessage=x=>x;');
 let answer;const requested=Promise.withResolvers();
 const endpoint=server.register('worker',{definitions:[],call:async()=>({text:'unused'}),authorize:async op=>{requested.resolve(op);return new Promise(resolve=>answer=resolve);}});
 const hooks=new Map();let guard;
 plugin({on:(name,fn)=>hooks.set(name,fn),tools:{guard:fn=>guard=fn}},{llmModule:llm,inbox:f.root,workspace:f.workspace,toolEndpoint:endpoint});
 t.after(()=>hooks.get('dispose')());
 const exec={name:'pwsh',arguments:{command:'git push'}};
 assert.match(guard(exec),/未执行/);
 let continued=false;
 const pending=hooks.get('tools/pre-execute')(exec,async()=>{continued=true;return {kind:'allow'};});
 assert.equal((await requested.promise).command,'git push');assert.equal(continued,false);
 answer({allowed:true,reason:'用户批准'});assert.equal((await pending).kind,'allow');assert.equal(continued,true);assert.equal(guard(exec),undefined);
 assert.match(guard({...exec}),/未执行/);
});
