// 真实验收，刻意不进入 npm test：Haiku 负责人 + Luna 同事，看派工、收件箱、停止归档、重启恢复。
if (!process.argv.includes('--authorized-this-run')) {
  console.error('真实模型验收必须传 --authorized-this-run');
  process.exitCode = 1;
} else {
  const { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { homedir } = await import('node:os');
  const base = resolve('.test-state'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'wake-check-')), home = join(root, 'home'), work = join(root, 'work'); mkdirSync(work);
  process.env.CREWROOM_HOME = home; process.env.CREWROOM_SMOKE = '1'; process.env.GIT_CEILING_DIRECTORIES = base;
  const { startApp } = await import('../dist/app/server.js');
  const open = () => startApp({ home, titleRequest: async () => { throw Error('验收不生成标题'); } });
  let app = await open();
  const call = async (path, data) => {
    const r = await fetch(app.origin + '/api/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await r.json(); if (!r.ok) throw Error(value.error); return value;
  };
  const later = ms => new Promise(r => setTimeout(r, ms));
  let id;
  const events = () => readFileSync(join(home, 'sessions', id, 'events.jsonl'), 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const settled = async () => {
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      const e = events(), s = e.findLastIndex(x => x.type === 'settled'), u = e.findLastIndex(x => x.type === 'from-user');
      if (s > u && u >= 0) return;
      await later(1000);
    }
    throw Error('240 秒内没有结束');
  };
  const where = thread => {
    const hit = d => { const walk = p => existsSync(p) && readdirSync(p).some(n => { const f = join(p, n); return statSync(f).isDirectory() ? walk(f) : n.includes(thread); }); return walk(join(homedir(), '.codex', d)); };
    return { active: hit('sessions'), archived: hit('archived_sessions') };
  };
  const wakes = from => events().slice(from).filter(e => e.type === 'wake').map(e => `${e.member}:${e.reason}+${e.inboxCount}`);
  const problems = [];
  const expect = (ok, text) => { console.log((ok ? 'ok   ' : 'FAIL ') + text); if (!ok) problems.push(text); };
  try {
    const project = await call('projects', { path: work });
    const session = await call('sessions', { projectId: project.id, title: '唤醒真实验收', mode: 'shared', members: [
      { name: 'lead', role: 'lead', harness: 'claude', model: 'claude-haiku-5-5' },
      { name: 'lu', role: 'worker', harness: 'codex', model: 'gpt-6-luna', effort: 'low' }] });
    id = session.id;
    await call(`sessions/${id}/messages`, { text: '这是验收。用 post_board 的 notify 把任务派给 lu，不要要求回复：运行 node -v，然后用 notify 把版本号告诉 lead，不要要求回复。派完就调用 wait_for_messages 等。看到版本号后告诉我，然后结束回复。' });
    await settled();
    let e = events();
    const thread = e.findLast(x => x.type === 'member-start' && x.member === 'lu')?.harnessId;
    console.log('第一轮唤醒', wakes(0));
    expect(e.some(x => x.type === 'wake' && x.member === 'lu' && x.reason === 'lead'), '负责人的普通通知叫醒了同事');
    const inboxed = e.filter(x => x.type === 'inbox' && x.member === 'lead').length;
    console.log('进负责人收件箱', inboxed, '条；工具回执', JSON.stringify(e.filter(x => x.type === 'tool-call' && x.member === 'lu').map(x => x.tool)));
    expect(!e.some(x => x.type === 'member-failed'), '第一轮没有成员失败');
    expect(e.filter(x => x.type === 'to-user').map(x => x.text).join('').match(/v?\d+\.\d+/) !== null, '负责人把版本号告诉了用户');
    await call(`sessions/${id}/pause`, {}); await later(1000);
    await app.close(); await later(1000);
    e = events();
    console.log('归档事件', JSON.stringify(e.filter(x => x.type === 'codex-archive').map(x => ({ success: x.success, error: x.error }))));
    expect(e.some(x => x.type === 'codex-archive' && x.success === true), '停止时归档成功');
    const hidden = where(thread); expect(hidden.archived && !hidden.active, `线程文件已移到归档 ${JSON.stringify(hidden)}`);
    const from = e.length;
    app = await open();
    await call(`sessions/${id}/resume`, {});
    await call(`sessions/${id}/messages`, { text: '继续。请 lu 再运行一次 node -v，这次要求它回复你。然后把结果告诉我，结束回复。' });
    await settled();
    e = events();
    console.log('第二轮唤醒', wakes(from));
    console.log('取消归档失败记录', JSON.stringify(e.slice(from).filter(x => x.type === 'codex-unarchive').map(x => String(x.error).slice(0, 120))));
    expect(e.slice(from).some(x => x.type === 'member-start' && x.member === 'lu' && x.harnessId === thread), '重启后恢复的是同一个线程');
    expect(e.slice(from).some(x => x.type === 'turn-start' && x.member === 'lu') || e.slice(from).some(x => x.type === 'wait-resume' && x.member === 'lu'), '恢复后同事真的又跑了一轮');
    expect(!e.slice(from).some(x => x.type === 'member-failed'), '第二轮没有成员失败');
    await call(`sessions/${id}/pause`, {}); await later(1000);
    await app.close(); app = undefined; await later(1000);
    const again = where(thread); expect(again.archived && !again.active, `第二次停止后又归档 ${JSON.stringify(again)}`);
  } catch (error) { console.error(String(error)); problems.push(String(error)); }
  finally { await app?.close(); console.log('验收数据保留在 ' + root); }
  console.log(problems.length ? '未通过：' + problems.join('；') : '全部通过');
  process.exitCode = problems.length ? 1 : 0;
}
