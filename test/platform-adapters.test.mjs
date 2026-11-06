import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../dist/platform/adapters/codex.js';
import { ClaudeAdapter, claudeEnv, CLAUDE_CONTEXT_WINDOW } from '../dist/platform/adapters/claude.js';
import { DshAdapter, disableSandbox } from '../dist/platform/adapters/dsh.js';
import { toolDenial } from '../dist/platform/permissions.js';
import { apply as steerPlugin } from '../dist/platform/dsh-steer-plugin.js';
import { scrubbedEnv } from '../dist/platform/env.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const codexPeer = String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.LOG,JSON.stringify({envKeys:Object.keys(process.env)})+'\n');
let n=0, total=0, current;
const send = f => process.stdout.write(JSON.stringify(f)+'\n');
const note = (method,params) => send({method,params});
const reply = (f,result) => send({id:f.id,result});
createInterface({input:process.stdin}).on('line', line=>{
 const f=JSON.parse(line); appendFileSync(process.env.LOG,JSON.stringify(f)+'\n');
 if(f.id===undefined || !f.method)return;
 if(f.method==='initialize')return reply(f,{});
 if(f.method==='config/read')return reply(f,{config:{mcp_servers:{personal:{}}}});
 if(f.method==='experimentalFeature/list')return reply(f,{data:[{name:'apps'},{name:'multi_agent'}]});
 if(f.method==='thread/start')return reply(f,{thread:{id:'thread'}});
 if(f.method==='account/rateLimits/read'&&process.env.QUOTA_FAIL)return send({id:f.id,error:{code:-32000,message:'quota probe unavailable'}});
 if(f.method==='account/rateLimits/read')return reply(f,{ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:10,resetsAt:1900000000}}});
 if(f.method==='turn/start'){
  const text=f.params.input[0].text; if(text==='crash')process.exit(17);
  if(text==='reject-quota')return send({id:f.id,error:{message:'exhausted',data:{codexErrorInfo:'rateLimitExceeded'}}});
  const id='turn-'+(++n); current=id;
  note('turn/started',{turn:{id}});
  note('item/agentMessage/delta',{turnId:id,delta:'PRIVATE_NOT_A_MESSAGE'});
  note('item/started',{turnId:id,item:{id:'tool-'+n,type:'commandExecution',command:'python alt_probe2.py'}});
  if(text==='web'){
    for(const [i,title] of ['WebSearch','WebFetch'].entries())send({id:'web-'+i,method:'session/request_permission',params:{sessionId:'fixture',toolCall:{toolCallId:'web-'+i,title,rawInput:{url:'https://example.com'}},options:[{optionId:'allow',kind:'allow_once',name:'allow'},{optionId:'reject',kind:'reject_once',name:'reject'}]}});
  }
  if(text==='permissions'){
   for(const [i,method] of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','unknown/request'].entries())send({id:'approval-'+i,method,params:{}});
  }
  const finish=()=>{
   total+=10;
   note('item/completed',{turnId:id,item:{id:'tool-'+n,type:'commandExecution'}});
   note('thread/tokenUsage/updated',{threadId:'thread',turnId:id,tokenUsage:{total:{inputTokens:total,outputTokens:total*2,totalTokens:total*3},last:{totalTokens:999}}});
   note('item/completed',{turnId:id,item:{type:'agentMessage',text:'message-'+n}});
   note('turn/completed',{turn:{id,status:['quota','rate'].includes(text)?'failed':'completed',...(['quota','rate'].includes(text)?{error:{message:'quota exhausted',codexErrorInfo:text==='rate'?'rateLimitExceeded':'usageLimitExceeded'}}:{})}});
  };
  if(text==='hold') {reply(f,{turn:{id}}); setTimeout(finish,120);}
  else {finish();setTimeout(()=>reply(f,{turn:{id}}),15);}
  return;
 }
 if(f.method==='turn/steer')return send({id:f.id,error:{code:-32000,message:'turn already ended'}});
 if(f.method==='turn/interrupt'){note('turn/completed',{turn:{id:current,status:'interrupted'}});return reply(f,{});}
 reply(f,{});
});
`;
const claudePeer = String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.LOG,JSON.stringify({envKeys:Object.keys(process.env)})+'\n');
let prompt, mode='default', selected='haiku', count=0;
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
const reply=(f,result)=>send({id:f.id,result});
const update=u=>send({method:'session/update',params:{sessionId:'fixture',update:u}});
const options=()=>[{id:'model',name:'Model',type:'select',currentValue:selected,options:[{value:selected,name:process.env.BAD_MODEL?'Opus 5.5':'Haiku 5.5'}]},
 {id:'mode',name:'Mode',type:'select',currentValue:mode,options:[{value:mode,name:mode}]},
 {id:'effort',name:'Effort',type:'select',currentValue:'low',options:[{value:'low',name:'Low'}]}];
createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line); appendFileSync(process.env.LOG,JSON.stringify(f)+'\n');
 if(f.id===undefined){if(f.method==='session/cancel'&&prompt){reply(prompt,{stopReason:'cancelled'});prompt=null;}return;}
 if(!f.method)return;
 if(f.method==='initialize')return reply(f,{protocolVersion:1,agentCapabilities:{},authMethods:[]});
 if(f.method==='session/new')return reply(f,{sessionId:'fixture',configOptions:options()});
 if(f.method==='session/set_config_option'){if(f.params.configId==='mode')mode=f.params.value;return reply(f,{configOptions:options()});}
 if(f.method==='_session/steering')return send({id:f.id,error:{code:-32601,message:'unsupported'}});
 if(f.method==='session/prompt'){
  const text=f.params.prompt[0].text;
  if(text==='crash')process.exit(19);
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'DO_NOT_RETAIN_THOUGHT'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text==='block-prose'?'<<<dm qwen\nwork\n>>>\n散文':text==='prose'?'一句没说完':'<<<boa'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text==='block-prose'?'':text==='prose'?'，':'rd\nfirst\n>>>'}});
  update({sessionUpdate:'tool_call',toolCallId:'tool',title:'Write',kind:'edit',status:'in_progress'});
  update({sessionUpdate:'tool_call_update',toolCallId:'tool',rawInput:{file_path:'file.txt'},status:'in_progress'});
  if(text==='web'){
    for(const [i,title] of ['WebSearch','WebFetch'].entries())send({id:'web-'+i,method:'session/request_permission',params:{sessionId:'fixture',toolCall:{toolCallId:'web-'+i,title,rawInput:{url:'https://example.com'}},options:[{optionId:'allow',kind:'allow_once',name:'allow'},{optionId:'reject',kind:'reject_once',name:'reject'}]}});
  }
  if(text==='permissions'){
    const cases=[['read','Read',{file_path:process.env.SESSION_DIR+'/board.md'}],['edit','Write',{file_path:process.env.SESSION_DIR+'/board.md'}],['edit','Write',{file_path:'file.txt'}],['execute','Bash',{command:'git push'}],['execute','Bash',{command:'node --test'}],['read','Read',{file_path:process.env.OUTSIDE+'/x'}]];
    for(const [i,[kind,title,rawInput]] of cases.entries())send({id:'permission-'+i,method:'session/request_permission',params:{sessionId:'fixture',toolCall:{toolCallId:'permission-'+i,kind,title,rawInput},options:[{optionId:'allow',kind:'allow_once',name:'allow'},{optionId:'reject',kind:'reject_once',name:'reject'},{optionId:'always',kind:'allow_always',name:'always'}]}});
  }
  const finish=()=>{
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text==='prose'?'继续后半句。':'final'}});
   if(text==='window'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' window='+process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW}});update({sessionUpdate:'usage_update',used:5,size:1000000});update({sessionUpdate:'usage_update',used:5,size:200000});}
   if(text==='quota')update({sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':{status:'rejected',unifiedWindows:{five_hour:{utilization:1,resetsAt:1900000000},seven_day:{utilization:0.7,resetsAt:1901000000}}}}});
   reply(f,{stopReason:'end_turn',usage:{inputTokens:11,outputTokens:7,totalTokens:18}});
  };
  if(text==='hold'){prompt=f;setTimeout(()=>{if(prompt){finish();prompt=null;}},120);}else setTimeout(finish,30);
  return;
 }
 send({id:f.id,error:{code:-32601,message:'unknown'}});
});
`;
function fixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'platform-protocol-')), workspace = join(root, 'workspace'), dir = join(root, 'session');
  mkdirSync(workspace); mkdirSync(dir); mkdirSync(join(root, 'outside')); writeFileSync(join(dir, 'board.md'), 'board');
  const file = join(root, 'peer.mjs'), log = join(root, 'log.jsonl'); writeFileSync(file, source);
  const adapters = [];
  t.after(async () => { for (const adapter of adapters) await adapter.stop(); rmSync(root, { recursive: true, force: true }); });
  const launch = { command: process.execPath, args: [file], cwd: workspace, env: { ...scrubbedEnv(), LOG: log, SESSION_DIR: dir, OUTSIDE: join(root, 'outside'), ANTHROPIC_BASE_URL: 'host-canary', CLAUDECODE: 'host-canary' } };
  return { root, workspace, dir, log, launch, adapters };
}
const frames = log => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const codexConfig = { name: 'sol', harness: 'codex', model: 'fake', effort: 'low', role: 'worker' };
const claudeConfig = { name: 'lead', harness: 'claude', model: 'claude-haiku-5-5', effort: 'low', role: 'lead' };

test('platform Codex handles completion before start response and uses cumulative usage differences', async t => {
  const fx = fixture(t, codexPeer), launches = [];
  const adapter = new CodexAdapter(codexConfig, fx.workspace, args => { launches.push(args); return fx.launch; });
  fx.adapters.push(adapter); const messages = [], events = []; adapter.onMessage = text => messages.push(text); adapter.onEvent = event => events.push(event);
  await adapter.start('member instructions');
  assert.ok(launches[1].includes('mcp_servers.personal.enabled=false')); assert.ok(launches[1].includes('multi_agent'));
  const first = await adapter.prompt('first'), second = await adapter.prompt('second');
  assert.equal(first.status, 'completed'); assert.equal(first.usage.totalTokens, 30); assert.equal(second.usage.totalTokens, 30);
  assert.deepEqual(messages, ['message-1', 'message-2']); assert.ok(events.some(e => e.type === 'tool'));
  assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>[e.id,e.status]),[['tool-1','in_progress'],['tool-1','completed'],['tool-2','in_progress'],['tool-2','completed']]);
  assert.equal(events.find(e=>e.type==='tool').command,'python alt_probe2.py');
  assert.equal(await adapter.steer('idle'), 'idle');
  const start = frames(fx.log).find(f => f.method === 'turn/start').params;
  // Real Codex refuses to resume a thread that has never run ("no rollout found"), which failed every new member.
  assert.equal(frames(fx.log).filter(f => f.method === 'thread/resume').length, 0);
  assert.equal(start.approvalPolicy, 'on-request'); assert.equal(start.approvalsReviewer, 'user');
  assert.deepEqual(start.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [fx.workspace], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(start.model, 'fake'); assert.equal(start.cwd, fx.workspace);
  for (const frame of frames(fx.log).filter(f => f.envKeys)) assert.ok(frame.envKeys.every(k => !/^(ANTHROPIC_|CLAUDE)/.test(k) || k === 'CLAUDE_CONFIG_DIR'));
});
test('platform Codex forwards approvals and rejects unsupported requests', async t => {
  const fx = fixture(t, codexPeer), adapter = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(adapter);
  const requested=[]; adapter.permission={level:()=> 'safe-write',online:()=>true,request:async op=>{requested.push(op);return {allowed:true,reason:'用户批准'};}};
  await adapter.start('instructions'); await adapter.prompt('permissions'); await tick();
  const answers = frames(fx.log).filter(f => typeof f.id === 'string' && f.id.startsWith('approval-')).sort((a,b)=>a.id.localeCompare(b.id));
  assert.equal(answers.length, 4); assert.equal(answers[0].result?.decision, 'accept',JSON.stringify(answers)); assert.equal(answers[1].result.decision, 'accept');
  assert.deepEqual(answers[2].result, { permissions: {}, scope: 'turn' }); assert.ok(answers[3].error);
});
test('platform Codex steer failures return idle, quota is reported, crash rejects promptly', async t => {
  const fx = fixture(t, codexPeer), adapter = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(adapter);
  await adapter.start('instructions');
  const tool = Promise.withResolvers(); adapter.onEvent = event => { if (event.type === 'tool') tool.resolve(); };
  const running = adapter.prompt('hold'); await tool.promise;
  assert.equal(await adapter.steer('race'), 'idle'); assert.equal((await running).status, 'completed');
  assert.equal((await adapter.prompt('quota')).status, 'quota');
  await assert.rejects(adapter.prompt('crash'), /HARNESS_EXITED/);
});
test('platform Claude compacts at 400K: the setting survives the env filter and the size shown is capped', async t => {
  const fx = fixture(t, claudePeer); fx.launch.env = { ...fx.launch.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: claudeEnv('claude.exe').CLAUDE_CODE_AUTO_COMPACT_WINDOW };
  assert.equal(fx.launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(CLAUDE_CONTEXT_WINDOW)); assert.equal(CLAUDE_CONTEXT_WINDOW, 400000);
  const adapter = new ClaudeAdapter(claudeConfig, fx.workspace, fx.dir, fx.launch); fx.adapters.push(adapter);
  const sizes = []; let text = ''; adapter.onEvent = e => { if (e.type === 'usage') sizes.push(e.size); }; adapter.onMessage = m => { text += m; };
  await adapter.start('member instructions'); await adapter.prompt('window');
  assert.match(text, /window=400000/);
  // A smaller model keeps its own window.
  assert.deepEqual(sizes, [400000, 200000]);
});
test('platform Claude checks model display names before any prompt and configures isolation', async t => {
  const fx = fixture(t, claudePeer), adapter = new ClaudeAdapter(claudeConfig, fx.workspace, fx.dir, fx.launch); fx.adapters.push(adapter);
  await adapter.start('member instructions'); const result = await adapter.prompt('work'); assert.equal(result.usage.totalTokens, 18);
  const newSession = frames(fx.log).find(f => f.method === 'session/new').params;
  assert.ok(newSession._meta.claudeCode.options.settings.permissions.ask.includes('Read'));
  const options = newSession._meta.claudeCode.options;
  assert.deepEqual(options.settingSources, []); assert.equal(options.strictMcpConfig, true); assert.deepEqual(options.plugins, []);
  assert.deepEqual(options.additionalDirectories, [fx.dir]); assert.equal(options.sandbox, undefined); assert.equal(options.systemPrompt.append, 'member instructions');
  const bad = fixture(t, claudePeer); bad.launch.env.BAD_MODEL = '1';
  const wrong = new ClaudeAdapter(claudeConfig, bad.workspace, bad.dir, bad.launch); bad.adapters.push(wrong);
  await assert.rejects(wrong.start('instructions'), /MODEL_NOT_APPLIED/);
  await assert.rejects(wrong.prompt('must not infer'), /not ready/);
  assert.ok(!frames(bad.log).some(f => f.method === 'session/prompt'));
});
test('platform Claude flushes messages at tools and turn end, ignores thought chunks, and supports quota', async t => {
  const fx = fixture(t, claudePeer), adapter = new ClaudeAdapter(claudeConfig, fx.workspace, fx.dir, fx.launch); fx.adapters.push(adapter);
  const messages = [], events = []; adapter.onMessage = text => messages.push(text); adapter.onEvent = e => events.push(e);
  await adapter.start('instructions'); await adapter.prompt('work'); assert.deepEqual(messages, ['<<<board\nfirst\n>>>', 'final']);
  assert.ok(!JSON.stringify(events).includes('DO_NOT_RETAIN_THOUGHT'));
  assert.ok(frames(fx.log).find(f => f.envKeys).envKeys.every(k => !/^(ANTHROPIC_|CLAUDE)/.test(k) || k === 'CLAUDE_CONFIG_DIR'));
  const quota = await adapter.prompt('quota'); assert.equal(quota.status, 'quota'); assert.equal(quota.quota.windows[0].usedPercent, 100); assert.match(quota.quota.windows[0].resetsAt, /^2030/);
});
test('platform Claude permission checks allow workspace and board reads, reject external writes and pushes', async t => {
  const fx = fixture(t, claudePeer), adapter = new ClaudeAdapter(claudeConfig, fx.workspace, fx.dir, fx.launch); fx.adapters.push(adapter);
  await adapter.start('instructions'); await adapter.prompt('permissions'); await tick();
  const answers = frames(fx.log).filter(f => typeof f.id === 'string' && f.id.startsWith('permission-'));
  assert.deepEqual(answers.map(f => f.result.outcome.optionId), ['allow', 'reject', 'allow', 'reject', 'allow', 'reject']);
});
test('platform Claude unsupported steer is safe, idle returns idle, cancellation and crash settle', async t => {
  const fx = fixture(t, claudePeer), adapter = new ClaudeAdapter(claudeConfig, fx.workspace, fx.dir, fx.launch); fx.adapters.push(adapter);
  await adapter.start('instructions'); assert.equal(await adapter.steer('idle'), 'idle');
  const tool = Promise.withResolvers(); adapter.onEvent = e => { if (e.type === 'tool') tool.resolve(); };
  const running = adapter.prompt('hold'); await tool.promise; assert.equal(await adapter.steer('unsupported'), 'unsupported');
  await adapter.interrupt(); assert.equal((await running).status, 'cancelled');
  await assert.rejects(adapter.prompt('crash'), /DISCONNECTED|closed|ended|exit|connection/i);
});
test('platform DSH uses the existing offline mock peer, confirms local selection, and injects instructions once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-dsh-')); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const model = { provider: 'strata-local', model: 'iq3_s', selection: '["strata-local","iq3_s"]', config: { baseURL: 'http://127.0.0.1:9' } };
  const adapter = new DshAdapter({ name: 'qwen', harness: 'dsh', model: 'local', role: 'worker' }, workspace, root,
    { model, launch: { command: process.execPath, args: [resolve('dist/mock-agent.js')], cwd: workspace, env: { ...scrubbedEnv(), MOCK_HOME: join(root, 'mock') } } });
  let dispose;
  t.after(async () => { dispose?.(); await adapter.stop(); rmSync(root, { recursive: true, force: true }); }); const messages = [], events = []; adapter.onMessage = text => messages.push(text); adapter.onEvent = e => events.push(e);
  await adapter.start('MEMBER_INSTRUCTIONS'); assert.equal(await adapter.steer('idle'), 'idle');
  assert.equal((await adapter.prompt('MOCK:plain')).status, 'completed'); assert.equal((await adapter.prompt('MOCK:plain')).status, 'completed');
  assert.deepEqual(messages, ['这是一条自然语言答复。', '这是一条自然语言答复。']); assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));
  const { readdirSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(join(root, 'mock', readdirSync(join(root, 'mock'))[0]), 'utf8'));
  assert.match(data.receivedPrompts[0], /^MEMBER_INSTRUCTIONS/); assert.equal(data.receivedPrompts[1], 'MOCK:plain');
  assert.equal(data.model, model.selection);
  const llmModule = join(root, 'fake-llm.mjs'); writeFileSync(llmModule, 'export const createUserMessage = value => value;');
  const steered = [];
  steerPlugin({ agents: new Map([[adapter.sessionId, { steer: message => steered.push(message) }]]), on: (_, callback) => { dispose = callback; } },
    { inbox: join(root, 'members', 'qwen', 'inbox'), llmModule });
  const tool = Promise.withResolvers(); adapter.onEvent = e => { if (e.type === 'tool') tool.resolve(); };
  const slow = adapter.prompt('MOCK:slow'); await tool.promise;
  assert.equal(await adapter.steer('teammate update'), 'steered'); assert.equal(steered[0].content[0].text, 'teammate update');
  await adapter.interrupt(); assert.equal((await slow).status, 'cancelled');
  await assert.rejects(adapter.prompt('MOCK:crash'), /DISCONNECTED|closed|ended|exit|connection/i);
});

test('platform DSH guard allows the working directory and denies everything outside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-')), workspace = join(root, 'work'), session = join(root, 'session');
  mkdirSync(workspace); mkdirSync(session);
  try {
    const deny = (name, input) => toolDenial(name, input, workspace, session);
    for (const [name, input] of [
      ['pwsh', { command: 'node --test' }], ['tool:pwsh', { command: 'git status' }], ['pwsh', { command: 'Set-Content inside.txt x', workdir: workspace }],
      ['write', { file_path: join(workspace, 'a.txt') }], ['edit', { path: 'src/new/b.txt' }], ['read', { file_path: join(root, 'anything') }], ['glob', {}],
    ]) assert.equal(deny(name, input), undefined, JSON.stringify(input));
    for (const [name, input] of [
      ['pwsh', { command: 'Set-Content ' + join(root, 'x.txt') + ' x' }], ['pwsh', { command: 'Set-Content ..\\x.txt x' }], ['pwsh', { command: 'git push origin main' }],
      ['pwsh', { command: 'collab send hi' }], ['pwsh', {}], ['pwsh', { command: 'node -v', run_in_background: true }], ['pwsh', { command: 'node -v', workdir: root }],
      ['tool:bash', { command: 'rm ' + join(root, 'x') }], ['write', { file_path: join(root, 'x.txt') }], ['edit', { path: '../x.txt' }], ['write', {}],
      ['write', { file_path: join(session, 'board', 'all.md') }],
    ]) assert.ok(deny(name, input), JSON.stringify(input));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('platform DSH plugin registers the guard, and refuses to start without one', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-'));
  const module = join(root, 'llm.mjs'); writeFileSync(module, 'export const createUserMessage = m => m;');
  const config = { llmModule: module, inbox: root, workspace: root, sessionDir: root };
  const listeners = [], guards = [];
  const ctx = { on: (name, fn) => listeners.push(fn), tools: { guard: fn => guards.push(fn) } };
  try {
    steerPlugin(ctx, config);
    assert.equal(guards.length, 1);
    assert.ok(guards[0]({ name: 'write', arguments: { file_path: join(root, '..', 'x') } }));
    assert.equal(guards[0]({ name: 'write', arguments: { file_path: join(root, 'x') } }), undefined);
    assert.throws(() => steerPlugin({ on() {} }, config), /PLATFORM_GUARD_UNAVAILABLE/);
  } finally { for (const fn of listeners) fn(); rmSync(root, { recursive: true, force: true }); }
});
test('platform DSH launch patch switches only the sandbox mode, and fails closed when it cannot', () => {
  const patch = '- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: "x"\n- id: approval\n  config:\n    policy: ask\n';
  const out = disableSandbox(patch);
  assert.ok(out.includes('mode: danger-full-access')); assert.ok(out.includes('policy: ask')); assert.ok(out.includes('workspaceRoot: "x"'));
  assert.throws(() => disableSandbox('- id: other\n'), /no sandbox-policy mode/);
});

test('Codex turns never query quota and explicit system read failures do not affect the turn', async t => {
  const fx=fixture(t,codexPeer);fx.launch.env.QUOTA_FAIL='1';
  const adapter=new CodexAdapter(codexConfig,fx.workspace,()=>fx.launch);fx.adapters.push(adapter);
  const events=[];adapter.onEvent=e=>events.push(e);await adapter.start('instructions');
  assert.equal((await adapter.prompt('work')).status,'completed');
  assert.equal((await adapter.prompt('rate')).status,'quota');
  assert.equal((await adapter.prompt('reject-quota')).status,'quota');
  assert.equal(frames(fx.log).filter(f=>f.method==='account/rateLimits/read').length,0); await assert.rejects(adapter.readQuota(),/quota probe unavailable/); assert.ok(frames(fx.log).some(f=>f.method==='turn/start'));
});
test('Claude retains prose across tool events and permits both web tools', async t => {
  const fx=fixture(t,claudePeer),adapter=new ClaudeAdapter(claudeConfig,fx.workspace,fx.dir,fx.launch);fx.adapters.push(adapter);
  const messages=[];adapter.onMessage=text=>messages.push(text);await adapter.start('instructions');
  await adapter.prompt('prose');assert.deepEqual(messages,['一句没说完，','继续后半句。']);
  await adapter.prompt('web');await tick();
  const responses=frames(fx.log).filter(f=>typeof f.id==='string'&&f.id.startsWith('web-'));
  assert.deepEqual(responses.map(f=>f.result.outcome.optionId),['allow','allow']);
  const disallowed=frames(fx.log).find(f=>f.method==='session/new').params._meta.claudeCode.options.disallowedTools;
  assert.ok(!disallowed.includes('WebSearch')&&!disallowed.includes('WebFetch'));
});

test('ACP dispatches a closed protocol block before tool execution even with trailing prose',async t=>{
 const fx=fixture(t,claudePeer),adapter=new ClaudeAdapter(claudeConfig,fx.workspace,fx.dir,fx.launch);fx.adapters.push(adapter);
 const order=[];adapter.onMessage=text=>order.push(['message',text]);adapter.onEvent=e=>{if(e.type==='tool')order.push(['tool']);};
 await adapter.start('instructions');await adapter.prompt('block-prose');
 assert.equal(order[0][0],'message');assert.match(order[0][1],/<<<dm qwen/);assert.equal(order[1][0],'tool');
});

// Approval promises remain unresolved until the platform answers them.
test('Claude forwards each ACP permission and returns only allow_once or reject_once',async t=>{
 const fx=fixture(t,claudePeer),adapter=new ClaudeAdapter(claudeConfig,fx.workspace,fx.dir,fx.launch);fx.adapters.push(adapter);
 const requests=[];
 adapter.permission={level:()=> 'safe-write',online:()=>true,request:operation=>new Promise(resolve=>requests.push({operation,resolve}))};
 await adapter.start('instructions');await adapter.prompt('permissions');
 assert.equal(requests.length,6);
 for(const [i,r] of requests.entries())r.resolve({allowed:i%2===0,reason:i%2===0?'用户批准':'平台规则拒绝'});
 const answered=()=>frames(fx.log).filter(f=>String(f.id).startsWith('permission-'));
 const deadline=Date.now()+5000;while(answered().length<6&&Date.now()<deadline)await tick();
 const answers=frames(fx.log).filter(f=>String(f.id).startsWith('permission-')).sort((a,b)=>a.id.localeCompare(b.id));
 assert.deepEqual(answers.map(f=>f.result.outcome.optionId),['allow','reject','allow','reject','allow','reject']);
});

test('Codex archive lifecycle: first rollout archives before RPC closes; unused thread does not', async t => {
  const fx = fixture(t, codexPeer), events = [];
  const unused = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(unused);
  await unused.start('unused'); await unused.stop();
  assert.equal(frames(fx.log).filter(f => f.method === 'thread/archive').length, 0);
  const used = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(used); used.onEvent = e => events.push(e);
  await used.start('used'); await used.prompt('first'); await used.stop(); await used.stop();
  assert.equal(frames(fx.log).filter(f => f.method === 'thread/archive').length, 1);
  assert.ok(events.some(e => e.type === 'codex-archive' && e.success === true));
});

test('Codex resume unarchives first, tolerates unarchived errors; archive failure still stops', async t => {
  const source = codexPeer.replace("if(f.method==='thread/start')", "if(['thread/archive','thread/unarchive'].includes(f.method))return send({id:f.id,error:{message:'fixture archive failure'}});\n if(f.method==='thread/resume')return reply(f,{thread:{id:'thread'}});\n if(f.method==='thread/start')");
  const fx = fixture(t, source), events = [];
  const adapter = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(adapter); adapter.onEvent = e => events.push(e);
  await adapter.resume('thread', 'resumed'); await adapter.stop();
  const methods = frames(fx.log).map(f => f.method);
  assert.ok(methods.indexOf('thread/unarchive') < methods.indexOf('thread/resume'));
  assert.ok(events.some(e => e.type === 'codex-archive' && e.success === false));
  await adapter.rpc.closed;
});

test('Codex active writer resume reports the desktop recovery instruction in Chinese', async t => {
  const fx = fixture(t, codexPeer.replace("if(f.method==='thread/start')", "if(f.method==='thread/resume')return send({id:f.id,error:{message:'thread already has an active writer'}});\n if(f.method==='thread/start')"));
  const adapter = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(adapter);
  await assert.rejects(adapter.resume('thread', 'resume'), /这个线程正被 Codex 桌面版打开，请完全退出 Codex 桌面版后重试/);
});

test('Codex archive timeout is bounded and still closes RPC', async t => {
  const fx = fixture(t, codexPeer.replace("if(f.method==='thread/start')", "if(f.method==='thread/archive')return;\n if(f.method==='thread/resume')return reply(f,{thread:{id:'thread'}});\n if(f.method==='thread/start')"));
  const adapter = new CodexAdapter(codexConfig, fx.workspace, () => fx.launch); fx.adapters.push(adapter);
  const events = []; adapter.onEvent = e => events.push(e);
  await adapter.resume('thread', 'resume');
  const at = Date.now(); await adapter.stop();
  assert.ok(Date.now() - at < 8000);
  assert.ok(events.some(e => e.type === 'codex-archive' && !e.success && /Timeout/.test(e.error)));
  await adapter.rpc.closed;
});
