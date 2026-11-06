import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// No service discovery, real adapters, model scans or desktop processes.
export async function startPreview(urlFile) {
  const workspace = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const output = resolve(urlFile), rel = relative(workspace, output);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('地址文件必须位于仓库内');
  const base = join(workspace,'.test-state'); mkdirSync(base,{recursive:true});
  const root = mkdtempSync(join(base,'ui-preview-'));
  process.env.GIT_CEILING_DIRECTORIES = base;
  process.env.CREWROOM_HOME = join(root,'home');
  process.env.CREWROOM_SMOKE = '1';
  const { startApp } = await import('../dist/app/server.js');
  const { initRepository } = await import('../dist/platform/storage.js');
  const project = join(root,'project'), home = process.env.CREWROOM_HOME;
  mkdirSync(project,{recursive:true});
  writeFileSync(join(project,'说明.txt'),'第一版：团队工作台\n');
  writeFileSync(join(project,'AGENTS.md'),'请使用中文，修改前运行离线测试。\n');
  mkdirSync(join(project,'.agent-notes'));
  writeFileSync(join(project,'.agent-notes','codex.md'),'**项目笔记**：这是隔离预览项目。');
  await initRepository(project);
  writeFileSync(join(project,'说明.txt'),'第二版：等待提示、成员卡片与文件差异\n');
  writeFileSync(join(project,'新增.txt'),'尚未跟踪的新文件\n');
  const id='preview-session', dir=join(home,'sessions',id);
  mkdirSync(join(dir,'board'),{recursive:true});mkdirSync(join(home,'quota'),{recursive:true});
  const members=[{name:'负责人',role:'lead',harness:'codex',model:'预览模型'}, {name:'检查员',role:'worker',harness:'dsh',model:'local'}, {name:'测试员',role:'worker',harness:'claude',model:'预览模型'}];
  members.push(...['等待员','工具员','已完成'].map(name=>({name,role:'worker',harness:'claude',model:'预览模型'})));
  const config={workspace:project,mode:'shared',members};
  writeFileSync(join(home,'projects.json'),JSON.stringify([{id:'preview-project',path:project}]));
  writeFileSync(join(dir,'session.json'),JSON.stringify({id,projectId:'preview-project',title:'等待确认 · 中文界面预览',config,createdAt:new Date().toISOString(),harnessIds:Object.fromEntries(members.map(m=>[m.name,'preview-'+m.name]))}));
  const events=[];
  const add=(type,data={})=>events.push({type,at:new Date().toISOString(),...data});
  add('session-start',{config});add('snapshot',{error:'历史快照失败示例（默认折叠）'});
  for(let i=0;i<12;i++) {add('from-user',{text:`第${i+1}轮：请检查中文界面在长对话里的阅读体验。\n`+'需要保留草稿、滚动位置和清晰的负责人回复。'.repeat(8)});add('to-user',{member:'负责人',text:'已检查这一轮布局。\n\n**检查重点**：输入框保持可见，团队活动归组收起。\n'+'这是一段较长的中文说明，用来观察排版、换行和窄窗口体验。'.repeat(10)});}
  add('turn-start',{member:'检查员'});
  for(let i=0;i<360;i++)add('tool',{member:'检查员',id:'tool-'+i,title:'读取界面文件 '+i,status:'completed'});
  add('usage',{member:'检查员',used:12400,size:64000});
  add('board',{author:'检查员',id:'b1',text:'**布局检查**\n- 输入框始终可见\n- 成员卡片持续显示'});
  add('dm',{author:'检查员',recipient:'负责人',id:'d1',text:'长对话已检查，请确认后续方案。'});
  add('turn-start',{member:'测试员'});add('turn-end',{member:'测试员',status:'failed',error:'离线预览：测试夹具模拟失败',usage:{inputTokens:1500,outputTokens:300}});add('member-failed',{member:'测试员',error:'离线预览：测试夹具模拟失败，可点击重试'});
  add('turn-start',{member:'负责人'});add('to-user',{member:'负责人',messageId:'lead:final',text:'**需要你确认**：下一步先检查窄窗口布局，还是先查看文件差异？\n\n请在下方输入框回复。检查员仍在处理工具记录，测试员失败的原因在右侧卡片里。'});add('wait-start',{member:'负责人'});
  writeFileSync(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
  writeFileSync(join(dir,'board','all.md'),'**布局检查**\n\n- 输入框始终可见\n- 成员卡片持续显示\n\n```js\nconsole.log("离线预览");\n```');
  writeFileSync(join(home,'quota','codex.json'),JSON.stringify({harness:'codex',observedAt:new Date(Date.now()-180000).toISOString(),windows:[{label:'5h',usedPercent:91,resetsAt:new Date(Date.now()+3600000).toISOString()}]}));
  writeFileSync(join(home,'quota','claude.json'),JSON.stringify({harness:'claude',observedAt:new Date(Date.now()-180000).toISOString(),windows:[{label:'weekly',usedPercent:89,resetsAt:new Date(Date.now()+86400000).toISOString()}]}));
  const runningDir=join(home,'sessions','preview-z-running');mkdirSync(runningDir,{recursive:true});
  writeFileSync(join(runningDir,'session.json'),JSON.stringify({id:'preview-z-running',projectId:'preview-project',title:'团队工作中 · 切换可验证草稿',config,createdAt:new Date().toISOString(),harnessIds:Object.fromEntries(members.map(m=>[m.name,'preview-'+m.name]))}));
  writeFileSync(join(runningDir,'events.jsonl'),[{type:'session-start',config},{type:'from-user',text:'请继续检查项目。'},{type:'turn-start',member:'负责人'},{type:'to-user',member:'负责人',text:'正在检查布局与工具调用，稍后汇报。'},{type:'tool',member:'负责人',id:'running',title:'检查界面布局',status:'in_progress'}].map(e=>JSON.stringify({...e,at:new Date().toISOString()})+'\n').join(''));
  const factory = () => ({getSessionId(){return 'preview-fake';},onMessage(){},onEvent(){},async start(){},async resume(){},async stop(){},async interrupt(){},async steer(){return 'idle';},async prompt(){this.onMessage('已收到你的回答。这是离线假适配器的回复。');return {status:'completed',usage:{inputTokens:24,outputTokens:20}};}});
  const app=await startApp({home,factory,scanners:{claude:async()=>[],codex:async()=>[],dsh:async()=>[]}});
  // Load only our fake session, so it represents live work rather than a cold journal.
  const loaded=await fetch(app.origin+'/api/sessions/'+id+'/pause',{method:'POST',headers:{Authorization:'Bearer '+app.token,Origin:app.origin}});
  if(!loaded.ok) { await app.close(); throw Error('无法载入隔离预览'); }
  const session=app.live.get(id);
  session.resume(); await session.waitForSettled();
  // Historical fixture timestamps must survive; normal storage.event deliberately stamps now.
  const emit=(type,data={})=>{
    const event={type,at:new Date().toISOString(),...data};
    appendFileSync(join(dir,'events.jsonl'),JSON.stringify(event)+'\n');
    session.storage.callback(event);
  };
  session.permissions.set('检查员','read-only');
  session.permissions.setNetwork(false);
  const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
  emit('turn-start',{member:'检查员',at:ago(15)});
  emit('tool',{member:'检查员',id:'long-python',kind:'commandExecution',command:'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; python alt_probe2.py --full | Out-String',status:'in_progress',at:ago(15)});
  emit('tool',{member:'检查员',id:'second-tool',title:'读取输出文件',status:'in_progress',at:ago(9)});
  emit('turn-start',{member:'负责人',at:ago(10)});
  emit('dm',{author:'负责人',recipient:'检查员',id:'preview-ask',text:'@检查员 请把脚本结果发给我。',reply_requested:true});
  emit('reply-pending',{requester:'负责人',recipient:'检查员',id:'preview-ask'});
  emit('to-user',{member:'负责人',messageId:'preview:question',text:'请确认下一步先检查窄窗口，还是文件差异？检查员的 Python 已运行十几分钟。'});
  emit('wait-start',{member:'负责人',at:ago(10)});
  for(const minutes of [9,8,7]) emit('tool',{member:'负责人',id:'wait-heartbeat',title:'mcp__agents__wait_for_messages',status:'in_progress',at:ago(minutes)});
  emit('tool',{member:'测试员',id:'stale',title:'不应继续显示的旧工具',status:'in_progress',at:ago(20)});
  emit('member-failed',{member:'测试员',error:'离线预览：测试夹具模拟失败，可点击重试'});
  emit('turn-start',{member:'等待员',at:ago(12)});
  for(const minutes of [12,11,10]) emit('tool',{member:'等待员',id:'unknown-wait',title:'wait_for_messages',status:'in_progress',at:ago(minutes)});
  emit('turn-start',{member:'工具员',at:ago(4)});
  emit('tool',{member:'工具员',id:'no-command',title:'读取大型分析结果',status:'in_progress',at:ago(4)});
  emit('turn-start',{member:'已完成',at:ago(18)});
  emit('tool',{member:'已完成',id:'missing-end',command:'python old_probe.py',at:ago(18)});
  emit('turn-end',{member:'已完成',status:'completed',at:ago(2)});
  const approval={id:'preview-permission',member:'已完成',operation:{command:'Start-Process preview.txt',cwd:project,reason:'离线预览申请（假适配器）'}};
  session.permissions.pending.set(approval.id,{...approval,resolve:()=>{}});
  emit('permission-request',approval);
  writeFileSync(output,app.url,{mode:0o600});
  return {app,root,id,project};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const output=process.argv[process.argv.indexOf('--url-file')+1];
  if(!process.argv.includes('--url-file') || !output) throw Error('用法：node scripts/ui-preview.mjs --url-file .test-state/preview-url.txt');
  const {app}=await startPreview(output);
  console.log('离线预览已启动，地址已写入指定文件；按 Ctrl+C 停止。');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>process.exit());});
}
