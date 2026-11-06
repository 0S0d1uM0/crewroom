// 真实验收，刻意不进入 npm test：用 Haiku 确认压缩阈值真的传到了 Claude。它默认约 96.7 万才压缩。
// 可选 --limit N，默认用平台的默认值。每轮约加 9 万，所以压缩点的精度也只有这么粗。
if (!process.argv.includes('--authorized-this-run')) {
  console.error('真实模型验收必须传 --authorized-this-run');
  process.exitCode = 1;
} else {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { ClaudeAdapter, claudeAcpEntry, claudeEnv, CLAUDE_CONTEXT_WINDOW } = await import('../dist/platform/adapters/claude.js');
  const base = resolve('.test-state'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'compact-check-')), work = join(root, 'work'), dir = join(root, 'session'); mkdirSync(work); mkdirSync(dir);
  const executable = process.env.CREWROOM_CLAUDE ?? join(homedir(), '.local', 'bin', 'claude.exe');
  const at = process.argv.indexOf('--limit'), limit = at > 0 ? Number(process.argv[at + 1]) : CLAUDE_CONTEXT_WINDOW;
  const launch = { command: process.execPath, args: [claudeAcpEntry()], cwd: work, env: claudeEnv(executable, limit) };
  const adapter = new ClaudeAdapter({ name: 'checker', role: 'lead', harness: 'claude', model: 'claude-haiku-5-5' }, work, dir, launch);
  const readings = [];
  adapter.onEvent = e => { if (e.type === 'usage' && typeof e.used === 'number') readings.push(e.used); };
  // Numbers do not compress into few tokens, so this is roughly 90 thousand tokens a message.
  const filler = n => Array.from({ length: 30000 }, (_, i) => (i * 7919 + n * 104729) % 1000003).join(' ');
  let peak = 0, compacted = false;
  try {
    await adapter.start('Answer with the single word OK. Ignore any numbers you are given.');
    for (let n = 1; n <= 8 && !compacted; n++) {
      const before = readings.length;
      const result = await adapter.prompt(`Reply OK.\n${filler(n)}`);
      const fresh = readings.slice(before);
      console.log(`第 ${n} 轮 ${result.status} 上下文读数`, fresh.join(' → '));
      for (const used of fresh) { if (used < peak * 0.6) compacted = true; peak = Math.max(peak, used); }
    }
    console.log(`最高 ${peak}，阈值 ${limit}`);
    const near = compacted && peak <= limit + 130000;
    console.log(near ? '通过：到阈值附近后发生了压缩' : '未通过：没有在阈值附近压缩');
    process.exitCode = near ? 0 : 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { await adapter.stop(); }
}
