// 真实验收，刻意不进入 npm test。在仓库内创建独立项目和应用数据。
if (!process.argv.includes('--authorized-this-run')) {
  console.error('真实模型验收必须传 --authorized-this-run');
  process.exitCode = 1;
} else {
  const { mkdtempSync, mkdirSync, existsSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const base = resolve('.test-state'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base,'permission-check-'));
  process.env.CREWROOM_HOME = join(root,'home'); process.env.CREWROOM_SMOKE = '1';
  process.env.GIT_CEILING_DIRECTORIES = base;
  const { startApp } = await import('../dist/app/server.js');
  const app = await startApp({ home: process.env.CREWROOM_HOME, titleRequest: async () => { throw Error('验收不生成标题'); } });
  const controller = new AbortController();
  const call = async (path, data) => {
    const r = await fetch(app.origin+'/api/'+path,{method:'POST',headers:{Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
    const value=await r.json(); if(!r.ok)throw Error(value.error); return value;
  };
  const expected = new Map(), seen = new Set();
  const stream = (async () => {
    const r=await fetch(app.origin+'/api/stream?token='+app.token,{signal:controller.signal});
    let buffer=''; const decoder=new TextDecoder();
    for await(const chunk of r.body) {
      buffer+=decoder.decode(chunk,{stream:true}); let end;
      while((end=buffer.indexOf('\n\n'))>=0) {
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const line=frame.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
        const f=JSON.parse(line.slice(6)), e=f.event;
        if(e?.type!=='permission-request')continue;
        if(seen.has(f.sessionId)) {await call('sessions/'+f.sessionId+'/permissions',{action:'answer',id:e.id,decision:'reject'});continue;}
        seen.add(f.sessionId);
        await call('sessions/'+f.sessionId+'/permissions',{action:'answer',id:e.id,decision:expected.get(f.sessionId)});
        console.log(JSON.stringify({session:f.sessionId,decision:expected.get(f.sessionId),operation:e.operation}));
      }
    }
  })();
  try {
    for(const [harness,model,effort,decision] of [['codex','gpt-6-luna','low','once'],['claude','claude-haiku-5-5',undefined,'reject'],['dsh','local',undefined,'once']]) {
      const project=join(root,harness);mkdirSync(project);
      const p=await call('projects',{path:project});
      const session=await call('sessions',{projectId:p.id,title:'权限真实验收 '+harness,members:[{name:'checker',role:'lead',harness,model,...(effort?{effort}:{}),permission:'read-only'}]});
      expected.set(session.id,decision);
      const timer=setTimeout(()=>{void app.live.get(session.id)?.stop();},180000);
      try {
        await call('sessions/'+session.id+'/messages',{text:'这是权限验收。只发起一次操作，在当前目录写入 permission-check.txt，内容为 permission-check。请直接调用工具，需要时请求提权。被拒后结束，不换方式重试。'});
        await app.live.get(session.id).waitForSettled();
        if(!seen.has(session.id))throw Error(harness+' 未产生审批，验收失败');
        if(existsSync(join(project,'permission-check.txt')) !== (decision==='once'))throw Error(harness+' 文件效果与审批结果不符');
      } finally {clearTimeout(timer);await app.live.get(session.id)?.stop();}
    }
  } catch(error) {console.error(String(error));process.exitCode=1;}
  finally {controller.abort();await stream.catch(()=>{});await app.close();console.log('验收数据保留在 '+root);}
}
