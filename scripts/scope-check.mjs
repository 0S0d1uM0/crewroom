// 真实验收，刻意不进入 npm test：Haiku 负责人 + Luna、本地 Qwen 同事，看工作单、新需求上报和检查点。
// 任务里不提这些规则：要验证的是提示词本身。负责人和成员的行为由人看输出判断，只有检查点是硬性检查。
if (!process.argv.includes('--authorized-this-run')) {
  console.error('真实模型验收必须传 --authorized-this-run');
  process.exitCode = 1;
} else {
  const { mkdtempSync, mkdirSync, readFileSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const base = resolve('.test-state'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'scope-check-')), home = join(root, 'home'), work = join(root, 'work'); mkdirSync(work);
  process.env.CREWROOM_HOME = home; process.env.CREWROOM_SMOKE = '1'; process.env.GIT_CEILING_DIRECTORIES = base;
  const { startApp } = await import('../dist/app/server.js');
  const app = await startApp({ home, titleRequest: async () => { throw Error('验收不生成标题'); } });
  const call = async (path, data) => {
    const r = await fetch(app.origin + '/api/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });
    const value = await r.json(); if (!r.ok) throw Error(value.error); return value;
  };
  const later = ms => new Promise(r => setTimeout(r, ms));
  let id;
  const events = () => readFileSync(join(home, 'sessions', id, 'events.jsonl'), 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const settled = async (limit = 420000) => {
    const until = Date.now() + limit;
    while (Date.now() < until) {
      const e = events(), s = e.findLastIndex(x => x.type === 'settled'), u = e.findLastIndex(x => x.type === 'from-user');
      // 这里验收的是协作，不是权限：隔离目录里成员的申请一律批准一次。先于结束判断，因为等批准时团队也会安静下来。
      const answered = new Set(e.filter(x => x.type === 'permission-result').map(x => x.id));
      const asking = e.filter(x => x.type === 'permission-request' && !answered.has(x.id));
      for (const p of asking) { console.log(`  [批准] ${p.member}: ${String(p.operation?.command ?? p.operation?.name).slice(0, 80)}`); await call(`sessions/${id}/permissions`, { action: 'answer', id: p.id, decision: 'once' }).catch(error => console.log('  批准失败', String(error).slice(0, 120))); }
      if (!asking.length && s > u && u >= 0) return;
      await later(1000);
    }
    throw Error('超时没有结束');
  };
  const show = from => {
    const e = events().slice(from);
    for (const x of e) {
      if (['board', 'dm'].includes(x.type)) console.log(`  [${x.type}] ${x.author}${x.recipient ? ' -> ' + x.recipient : ''}: ${x.text.replace(/\s+/g, ' ').slice(0, 700)}`);
      if (x.type === 'to-user') console.log(`  [给用户] ${x.text.replace(/\s+/g, ' ').slice(0, 500)}`);
      if (x.type === 'member-failed') console.log(`  [失败] ${x.member}: ${String(x.error).slice(0, 200)}`);
    }
    console.log('  唤醒', e.filter(x => x.type === 'wake').map(x => `${x.member}:${x.reason}+${x.inboxCount}`).join(' '));
    return e;
  };
  const problems = [];
  try {
    const project = await call('projects', { path: work });
    const session = await call('sessions', { projectId: project.id, title: '协作规则真实验收', mode: 'shared', members: [
      { name: 'lead', role: 'lead', harness: 'claude', model: 'claude-haiku-5-5' },
      { name: 'lu', role: 'worker', harness: 'codex', model: 'gpt-6-luna', effort: 'low' },
      { name: 'qw', role: 'worker', harness: 'dsh', model: 'local' }] });
    id = session.id;

    console.log('=== 第一轮：普通开工，看有没有工作单');
    let from = events().length;
    await call(`sessions/${id}/messages`, { text: '请让 lu 写一个 add.js（命令行读两个数字，打印它们的和），qw 来审阅。做完告诉我。' });
    await settled(); show(from);

    console.log('=== 第二轮：让成员有机会发现新需求，看是否先上报');
    from = events().length;
    await call(`sessions/${id}/messages`, { text: '请让 qw 再看看 add.js 还有哪些可以增强的地方，让 lu 跟进。' });
    await settled(); show(from);

    console.log('=== 第三轮：成员互发消息，看检查点');
    from = events().length;
    await call(`sessions/${id}/messages`, { text: '这是平台通信测试：请让 lu 和 qw 用私信互发 ping，每人发 7 条，内容是序号，不要求回复，也不抄送你。你不用参与，发完告诉我。' });
    await settled();
    const e = show(from);
    const checkpoints = e.filter(x => x.type === 'checkpoint');
    const wakes = e.filter(x => x.type === 'wake' && x.member === 'lead' && x.reason === 'checkpoint');
    const pings = e.filter(x => x.type === 'dm' && x.author !== 'lead' && x.recipient !== 'lead').length;
    console.log(`  成员互发 ${pings} 条，检查点 ${checkpoints.length} 次，叫醒负责人 ${wakes.length} 次`);
    const expected = Math.floor(pings / 12);
    if (pings >= 12 && (!wakes.length || checkpoints.length > expected + 1)) problems.push(`检查点次数不对：${pings} 条消息，${checkpoints.length} 次检查点`);
    if (pings < 12) console.log('  成员没发够 12 条，这一轮没有验证到检查点');
    const usage = e.filter(x => x.type === 'usage' && x.member === 'lead' && x.used).map(x => x.used);
    if (usage.length) console.log('  负责人上下文', usage.at(0), '->', usage.at(-1));
    if (events().some(x => x.type === 'member-failed')) problems.push('有成员失败');
  } catch (error) { console.error(String(error)); problems.push(String(error)); }
  finally { await app.close(); console.log('验收数据保留在 ' + root); }
  console.log(problems.length ? '未通过：' + problems.join('；') : '硬性检查通过，行为请看上面的输出');
  process.exitCode = problems.length ? 1 : 0;
}
