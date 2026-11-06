import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, memberActivity, commandSummary, visibleActivities, coalesceRecords, permissionHistory, activityLabel } from '../ui/state.js';

test('a member record has one row per tool call, says what ran, and leaves out meters and wait heartbeats', () => {
  const command = '"C:\\pwsh.exe" -Command "python tools\\run.py --all"';
  const rows = coalesceRecords([
    { type: 'usage', member: 'a', used: 1 }, { type: 'rate-limits', member: 'a' }, { type: 'tool-call', member: 'a', tool: 'post_board' },
    { type: 'tool', member: 'a', id: 'w', title: 'mcp__agents__wait_for_messages', status: 'in_progress' },
    { type: 'tool', member: 'a', id: 'w', title: 'mcp__agents__wait_for_messages', status: 'in_progress' },
    { type: 'tool', member: 'a', id: 'x', kind: 'commandExecution', command, status: 'in_progress' },
    { type: 'tool', member: 'a', id: 'x', kind: 'commandExecution', command, status: 'completed' },
    { type: 'tool', member: 'a', id: 'y', kind: 'fileChange', paths: ['docs/a.md', 'docs/b.md'], status: 'completed' },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(visibleActivities([{type:'wake',member:'a'},{type:'inbox',member:'a',text:'x'},{type:'codex-archive',member:'a'}]), []);
  assert.equal(rows[0].status, 'completed'); assert.equal(rows[0].command, command);
  assert.equal(activityLabel(rows[0]), 'a · 运行 run.py');
  assert.equal(activityLabel(rows[1]), 'a · 修改 a.md 等 2 个文件');
});

test('permission history joins request and outcome, keeps the command, and collapses repeats', () => {
  const operation = { command: 'python lab/launch_client.py', cwd: 'E:\\x', reason: '测试' };
  const rows = permissionHistory([
    { type: 'permission-request', id: '1', member: 'a', operation, at: '2026-11-05T01:00:00Z' },
    { type: 'permission-grant', id: 'g', member: 'a', command: operation.command, cwd: operation.cwd, at: '2026-11-05T01:01:00Z' },
    { type: 'permission-result', id: '1', member: 'a', decision: 'session', allowed: true, reason: '用户批准', at: '2026-11-05T01:01:00Z' },
    { type: 'permission-denied', member: 'b', operation: { command: 'cat .env' }, reason: '凭据保护', at: '2026-11-05T01:02:00Z' },
    { type: 'permission-denied', member: 'b', operation: { command: 'cat .env' }, reason: '凭据保护', at: '2026-11-05T01:03:00Z' },
    { type: 'permission-changed', member: 'a', level: 'full-write', byUser: true, at: '2026-11-05T01:04:00Z' },
    { type: 'permission-request', id: '2', member: 'a', operation, at: '2026-11-05T01:05:00Z' },
  ]);
  assert.deepEqual(rows.map(r => r.outcome), ['等你批准', '你改的', '平台规则拒绝', '已允许（本会话相同命令）']);
  assert.equal(rows[0].label, 'a · launch_client.py'); assert.equal(rows[0].operation.command, operation.command);
  assert.equal(rows[1].label, 'a 权限改为 全面读写');
  assert.equal(rows[2].count, 2); assert.equal(rows[2].at, '2026-11-05T01:03:00Z');
});

const now=Date.parse('2026-11-04T12:00:00Z');
const at=n=>new Date(now-n*60000).toISOString();
function fixture() {
  const s=initialState({members:['小克','小千','第三人'].map(name=>({name,role:'worker'}))});
  const add=(type,data={})=>reduce(s,{type,member:'小克',at:at(9),...data});
  const activity=(minutes=0)=>memberActivity(s,s.members['小克'],now+minutes*60000);
  add('turn-start');return {s,add,activity};
}
test('command card extracts script, strips shell plumbing, falls back and keeps full tooltip',()=>{
  const {add,activity}=fixture();
  const command='[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; python D:\\tmp\\alt_probe2.py --full | Out-String';
  add('tool',{id:'python',command,status:'in_progress'});
  assert.equal(activity().text,'正在运行 alt_probe2.py · 已运行 9 分钟');assert.equal(activity().title,command);
  assert.equal(commandSummary('git diff --stat | Out-String'),'git diff --stat');
  assert.equal(commandSummary('x'.repeat(160)).length,100);
  // Shapes taken from real Codex and DSH logs.
  assert.equal(commandSummary(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-ChildItem -LiteralPath 'docs/architecture'"`).startsWith('Get-ChildItem -LiteralPath'),true);
  assert.equal(commandSummary(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "python tools\\run.py --all"`),'run.py');
  assert.equal(commandSummary(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $env:ALT_BUDGET='430'; python -u docs\\work\\alt_probe2.py 2>&1 | Select-Object -Last 4`),'alt_probe2.py');
  assert.equal(commandSummary(`$env:PYTHONIOENCODING='utf-8'; git status`),'git status');
  // Real Codex shapes: the shell's odd quoting, and a script piped in through a here-string.
  assert.equal(commandSummary(`"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command '$env:PYTHONIOENCODING='"'utf-8'; python 'lab/probe/tools/launch_client.py' --label x"`),'launch_client.py');
  assert.equal(commandSummary(`"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command '$env:PYTHONIOENCODING='"'utf-8'; @'\nfrom pathlib import Path\nprint(1)\n'@ | python -"`),'内联脚本（2 行）');
  add('tool',{id:'python',status:'completed'});add('tool',{id:'read',title:'读取文件'});
  assert.match(activity().text,/正在运行 读取文件/);
});
test('oldest unfinished tool wins; updates preserve start time; finishing promotes next tool',()=>{
  const {add,activity}=fixture();
  add('tool',{id:'first',command:'python first.py',at:at(15)});
  add('tool',{id:'second',command:'python second.py',at:at(4)});
  add('tool',{id:'first',status:'in_progress',at:at(1)});
  assert.equal(activity().text,'正在运行 first.py · 已运行 15 分钟 · 还有 1 个工具');
  add('tool',{id:'first',status:'failed'});
  assert.equal(activity().text,'正在运行 second.py · 已运行 4 分钟');
});
test('Claude wait heartbeats are neither running tools nor activity and never reset elapsed time',()=>{
  const {s,add,activity}=fixture();
  for(const minutes of [9,8.5,8])add('tool',{id:'wait'+minutes,title:'mcp__agents__wait_for_messages',status:'in_progress',at:at(minutes)});
  add('wait-start',{at:at(7)});
  assert.equal(activity().text,'等待消息 · 已等 9 分钟');
  assert.equal(s.members['小克'].activeTools?.size ?? 0,0);
  assert.equal(s.activities.filter(e=>e.type==='tool').length,0);
  assert.ok(!visibleActivities(s.activities).some(e=>e.type==='tool'));
  add('wait-resume',{at:at(1)});add('wait-start',{at:at(1)});
  assert.equal(activity().text,'等待消息 · 已等 1 分钟');
});
test('explicit pending, ask, reply_requested and mentions identify recipients until a directed reply',()=>{
  for(const data of [
    {type:'reply-pending',requester:'小克',recipient:'小千',id:'a'},
    {type:'board',author:'小克',ask:['小千'],id:'a'},
    {type:'dm',author:'小克',recipient:'小千',reply_requested:true,id:'a'},
    {type:'board',author:'小克',text:'@小千 请回复',id:'a'},
    {type:'board',author:'小克',text:'请@小千看看',id:'a'},
  ]) {
    const {add,activity}=fixture();add(data.type,data);add('wait-start');
    assert.equal(activity().text,'在等小千 · 已等 9 分钟');
    add('member-text',{member:'小千',text:'还在处理'});assert.match(activity().text,/在等小千/);
    add('dm',{author:'小千',recipient:'小克',id:'answer',text:'已完成'});
    assert.equal(activity().text,'等待消息 · 已等 9 分钟');
  }
  const {add,activity}=fixture();add('dm',{author:'小克',recipient:'小千',reply_requested:false});add('wait-start');
  assert.match(activity().text,/^等待消息/);
  for(const text of ['`@小千`','> @小千','```\n@小千\n```','mail@小千']) {
    add('board',{author:'小克',text});assert.match(activity().text,/^等待消息/);
  }
});
test('a mentioned member stops being waited on when its turn ends, but a directed request does not',()=>{
  const {s,add,activity}=fixture();
  add('board',{author:'小克',id:'b',text:'@小千 请验证。@第三人 待命。'});add('wait-start');
  assert.match(activity().text,/^在等小千、第三人/);
  add('turn-start',{member:'第三人'});add('turn-end',{member:'第三人',status:'completed',parked:true});
  assert.match(activity().text,/^在等小千、第三人/,'a parked turn is still waiting, not finished');
  add('turn-start',{member:'第三人'});add('turn-end',{member:'第三人',status:'completed'});
  assert.match(activity().text,/^在等小千 /);
  add('reply-pending',{requester:'小克',recipient:'第三人',id:'r'});
  add('turn-start',{member:'第三人'});add('turn-end',{member:'第三人',status:'completed'});
  assert.match(activity().text,/^在等小千、第三人/,'a member that owes a reply stays listed');
  assert.equal(s.members['小克'].state,'等待消息');
});
test('a working member between tools reads as thinking, and only an idle one as standing by',()=>{
  const {s,add}=fixture();
  assert.equal(memberActivity(s,s.members['小克'],now).text,'思考中');
  assert.equal(memberActivity(s,s.members['第三人'],now).text,'待命');
  add('turn-end',{status:'completed'});
  assert.equal(memberActivity(s,s.members['小克'],now).text,'待命');
});
test('clearing a pending request and unrelated mentions cannot invent a wait target',()=>{
  const {add,activity}=fixture();
  add('reply-pending',{requester:'小克',recipient:'小千',id:'a'});add('wait-start');
  add('reply-cleared',{recipient:'小千',id:'a'});
  add('board',{author:'第三人',text:'@小千 请回复'});
  assert.equal(activity().text,'等待消息 · 已等 9 分钟');
});
test('turn completion, failure, restart and interruption clear unfinished tools and reject late updates',()=>{
  for(const type of ['turn-end','member-failed','member-start','member-interrupted','session-start','stopped']) {
    const {s,add,activity}=fixture();add('tool',{id:'stale',command:'python stale.py'});
    add(type,{status:'completed'});
    assert.equal(s.members['小克'].activeTools.size,0,type);
    assert.doesNotMatch(activity().text,/正在运行/,type);
    if(type==='turn-end') {add('tool',{id:'stale',status:'in_progress'});assert.doesNotMatch(activity().text,/正在运行/);}
  }
  const {add,activity}=fixture();add('wait-start');add('turn-end',{parked:true});
  assert.equal(activity().text,'等待消息 · 已等 9 分钟');
});
test('journal restoration calculates time from events, including future and invalid timestamps',()=>{
  const {s,add,activity}=fixture();add('tool',{id:'t',command:'python probe.py'});
  assert.match(activity(3).text,/已运行 12 分钟/);
  assert.doesNotMatch(memberActivity(s,s.members['小克'],now,false).text,/正在运行/);
  const restored=initialState(s.config);for(const event of s.activities)reduce(restored,event);
  assert.equal(memberActivity(restored,restored.members['小克'],now).text,activity().text);
  add('tool',{id:'t',status:'completed'});add('tool',{id:'future',title:'工具',at:at(-1)});
  assert.match(activity().text,/已运行 0 分钟/);
  add('tool',{id:'future',status:'completed'});add('tool',{id:'invalid',title:'工具',at:'invalid'});
  assert.doesNotMatch(activity().text,/NaN/);
});
test('reopening the app alerts only for events after it opened, never for the replayed log',async()=>{
  const { shouldAlert } = await import('../ui/state.js');
  const opened=Date.parse('2026-11-04T23:00:00Z');
  const old={type:'snapshot',error:'Error: spawnSync git ETIMEDOUT',at:'2026-11-04T16:33:27Z'};
  assert.equal(shouldAlert(old,opened),false);
  assert.equal(shouldAlert({...old,at:'2026-11-04T23:00:05Z'},opened),true);
  assert.equal(shouldAlert({type:'member-failed',at:'2026-11-04T20:19:04Z'},opened),false);
  assert.equal(shouldAlert({type:'member-failed',at:'2026-11-04T23:01:00Z'},opened),true);
  assert.equal(shouldAlert({type:'tool',at:'2026-11-04T23:01:00Z'},opened),false);
});
