import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialState, reduce, attention, coalesceRecords, tokenTotal, asksUser, memberActivity } from '../ui/state.js';
import { startPreview } from '../scripts/ui-preview.mjs';
import { gitAsync } from '../dist/platform/storage.js';

const members=[{name:'lead',role:'lead',harness:'codex',model:'fake'},{name:'w',role:'worker',harness:'dsh',model:'local'}];
test('waiting distinguishes a question, team work, teammate replies and answered messages',()=>{
 const s=initialState({members});
 const add=(type,data={})=>reduce(s,{type,...data});
 add('turn-start',{member:'w'});add('to-user',{member:'lead',text:'我会等队友完成'});add('wait-start',{member:'lead'});assert.equal(attention(s).waiting,false);
 add('to-user',{member:'lead',messageId:'l:1',text:'请确认方案？'});assert.equal(attention(s).waiting,true);
 add('message-update',{member:'lead',messageId:'l:1',text:'补充问题',append:true});assert.match(attention(s).text,/补充问题/);
 add('from-user',{text:'确认'});assert.equal(attention(s).waiting,false);
});
test('usage uses explicit totals or input/output and keeps context distinct',()=>{
 assert.equal(tokenTotal({input_tokens:8,output_tokens:3,cache_read_input_tokens:5}),11);
 assert.equal(tokenTotal({totalTokens:11,inputTokens:8,outputTokens:3,reasoningTokens:2}),11);
 const s=initialState({members});reduce(s,{type:'usage',member:'w',used:30,size:100});assert.equal(s.members.w.contextTokens,30);assert.equal(s.members.w.tokens,null);
 reduce(s,{type:'turn-end',member:'w',usage:{input_tokens:8,output_tokens:3}});assert.equal(s.members.w.tokens,11);
});
test('orphan message-update stays readable; legacy fragments join only within one turn',()=>{
 const rows=coalesceRecords([{type:'message-update',messageId:'x',text:'开始'},{type:'message-update',messageId:'x',text:'继续',append:true}]);assert.equal(rows[0].text,'开始继续');
 const s=initialState({members});for(const e of [{type:'turn-start',member:'lead'},{type:'to-user',member:'lead',text:'一'},{type:'tool',member:'lead'},{type:'to-user',member:'lead',text:'二'},{type:'turn-end',member:'lead'},{type:'to-user',member:'lead',text:'三'}])reduce(s,e);
 assert.equal(s.activities.filter(e=>e.type==='to-user').length,2);assert.equal(s.messages[0].text,'一\n\n二');
});
test('isolated preview supplies waiting summaries, actual diffs, rules, notes and retry',async t=>{
 const file=resolve('.test-state','preview-test-url.txt');
 const oldCeiling=process.env.GIT_CEILING_DIRECTORIES;delete process.env.GIT_CEILING_DIRECTORIES;
 const {app,root,id,project}=await startPreview(file);
 t.after(()=>{if(oldCeiling===undefined)delete process.env.GIT_CEILING_DIRECTORIES;else process.env.GIT_CEILING_DIRECTORIES=oldCeiling;});
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});rmSync(file,{force:true});});
 assert.equal(readFileSync(file,'utf8'),app.url);
 const call=async(path,body)=>{const r=await fetch(app.origin+'/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,value:await r.json()};};
 const state=(await call('state')).value;assert.equal(state.sessions[0].attention.waiting,true);
 const events=(await call(`sessions/${id}/events`)).value;assert.ok(events.filter(e=>e.type==='tool').length>=300);
 const ui=initialState(state.sessions[0].config);for(const e of events)reduce(ui,e);assert.equal(attention(ui).waiting,true);assert.equal(ui.members['测试员'].state,'失败');assert.equal(ui.members['检查员'].state,'工作中');
 assert.match(memberActivity(ui,ui.members['检查员']).text,/alt_probe2.py · 已运行 15 分钟 · 还有 1 个工具/);
 assert.match(memberActivity(ui,ui.members['检查员']).title,/OutputEncoding.*Out-String/);
 assert.equal(memberActivity(ui,ui.members['负责人']).text,'在等检查员 · 已等 10 分钟');
 assert.equal(memberActivity(ui,ui.members['等待员']).text,'等待消息 · 已等 12 分钟');
 assert.equal(memberActivity(ui,ui.members['工具员']).text,'正在运行 读取大型分析结果 · 已运行 4 分钟');
 assert.doesNotMatch(memberActivity(ui,ui.members['已完成']).text,/正在运行/);
 assert.equal(ui.members['测试员'].activeTools.size,0);
 const lastBeforeHeartbeat=(await call('state')).value.sessions.find(s=>s.id===id).lastActivity;
 app.live.get(id).storage.event('tool',{member:'等待员',id:'unknown-wait',title:'wait_for_messages',status:'in_progress',at:new Date(Date.now()+30000).toISOString()});
 assert.equal((await call('state')).value.sessions.find(s=>s.id===id).lastActivity,lastBeforeHeartbeat);
 const changes=(await call(`sessions/${id}/changes`)).value;assert.ok(changes.workspaces[0].files.some(f=>f.path==='说明.txt'));
 assert.match((await call(`sessions/${id}/changes?file=${encodeURIComponent('说明.txt')}`)).value.diff,/第二版/);
 assert.match((await call(`sessions/${id}/changes?file=${encodeURIComponent('新增.txt')}`)).value.diff,/新文件/);
 assert.equal((await call(`sessions/${id}/changes?file=..%2Foutside`)).status,400);
 const ctx=(await call(`sessions/${id}/context`)).value;assert.ok(ctx.files.some(f=>f.path==='.agent-notes/codex.md'&&!f.editable));
 assert.equal((await call(`sessions/${id}/context`,{path:'AGENTS.md',text:'新的中文规则'})).status,200);assert.equal(readFileSync(join(project,'AGENTS.md'),'utf8'),'新的中文规则');
 assert.equal((await call(`sessions/${id}/context`,{path:'.agent-notes/codex.md',text:'不能写'})).status,400);
 const retry=await call(`sessions/${id}/members/${encodeURIComponent('测试员')}/retry`,{});assert.equal(retry.status,200,JSON.stringify(retry.value));
 await app.live.get(id).waitForSettled();assert.equal(app.live.get(id).summary().members.find(m=>m.name==='测试员').failed,false);
 // Staged and renamed files retain exact Unicode/space paths.
 writeFileSync(join(project,'有 空格.txt'),'暂存内容');await gitAsync(project,['add','--','有 空格.txt']);
 assert.match((await call(`sessions/${id}/changes?file=${encodeURIComponent('有 空格.txt')}`)).value.diff,/暂存内容/);
 const consistency=(await call('sessions',{projectId:state.projects[0].id,members:state.sessions[0].config.members})).value;
 const local=initialState(consistency.config), journal=app.live.get(consistency.id).storage;
 const emit=(type,data={})=>reduce(local,journal.event(type,data));
 emit('turn-start',{member:'检查员'});
 for(const [i,text] of ['```js\nconst x = ok ? 1 : 0;\n```','> 这段引用？','布局检查完成','请确认方案','下一步看差异？'].entries()) {
   emit('from-user',{text:'继续'});emit('turn-start',{member:'负责人'});emit('to-user',{member:'负责人',messageId:'consistency:'+i,text});emit('wait-start',{member:'负责人'});
   const remote=(await call('state')).value.sessions.find(s=>s.id===consistency.id);
   assert.equal(remote.attention.waiting,attention(local).waiting,text);
 }
 emit('turn-start',{member:'负责人'});emit('turn-end',{member:'负责人',status:'completed'});assert.equal(attention(local).waiting,false);assert.equal((await call('state')).value.sessions.find(s=>s.id===consistency.id).attention.waiting,false);
 emit('to-user',{member:'负责人',text:'请确认方案'});emit('wait-start',{member:'负责人'});
 emit('paused');assert.equal((await call('state')).value.sessions.find(s=>s.id===consistency.id).attention.waiting,attention(local).waiting);
 const worktree=(await call('sessions',{projectId:state.projects[0].id,mode:'worktree',members:state.sessions[0].config.members})).value;
 assert.ok(worktree.id,JSON.stringify(worktree));
 const memberPath=join(app.home,'sessions',worktree.id,'worktrees','检查员');
 writeFileSync(join(memberPath,'成员文件.txt'),'独立工作树的改动');
 const areas=(await call(`sessions/${worktree.id}/changes`)).value.workspaces;
 assert.equal(areas.length,worktree.config.members.length+1);const area=areas.find(a=>a.path===memberPath);assert.ok(area.files.some(f=>f.path==='成员文件.txt'));
 assert.match((await call(`sessions/${worktree.id}/changes?workspace=${area.index}&file=${encodeURIComponent('成员文件.txt')}`)).value.diff,/独立工作树/);

});

test('quoted/code question marks do not imply a user decision',()=>{
 for(const text of ['```js\nconst x = ok ? 1 : 0;\n```','> 这是一段引用？','用 `a ? b : c` 表达条件'])assert.equal(asksUser(text),false);
 assert.equal(asksUser('下一步先看差异？'),true);assert.equal(asksUser('请你确认布局'),true);
});
